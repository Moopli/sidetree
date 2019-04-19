import Transaction from './Transaction';
import { Collection, MongoClient, Db } from 'mongodb';
import { TransactionStore } from './TransactionStore';

interface IUnresolvableTransaction extends Transaction {
  firstFetchTime: number;
  retryAttempts: number;
  nextRetryTime: number;
}

/**
 * Implementation of TransactionStore that stores the transaction data in a MongoDB database.
 */
export default class MongoDbTransactionStore implements TransactionStore {
  /** Default database name used if not specified in constructor. */
  public static readonly defaultDatabaseName: string = 'sidetree';
  /** Collection name for transactions. */
  public static readonly transactionCollectionName: string = 'transactions';
  /** Collection name for unresolvable transactions. */
  public static readonly unresolvableTransactionCollectionName: string = 'unresolvable-transactions';
  /** Database name used by this transaction store. */
  public readonly databaseName: string;

  private exponentialDelayFactorInMilliseconds = 60000;
  private maximumUnresolvableTransactionReturnCount = 100;

  private db: Db | undefined;
  private transactionCollection: Collection<any> | undefined;
  private unresolvableTransactionCollection: Collection<any> | undefined;

  /**
   * Constructs a `MongoDbTransactionStore`;
   * @param retryExponentialDelayFactor
   *   The exponential delay factor in milliseconds for retries of unresolvable transactions.
   *   e.g. if it is set to 1 seconds, then the delays for retries will be 1 second, 2 seconds, 4 seconds... until the transaction can be resolved.
   */
  constructor (private serverUrl: string, databaseName?: string, retryExponentialDelayFactor?: number) {
    this.databaseName = databaseName ? databaseName : MongoDbTransactionStore.defaultDatabaseName;

    if (retryExponentialDelayFactor !== undefined) {
      this.exponentialDelayFactorInMilliseconds = retryExponentialDelayFactor;
    }
  }

  /**
   * Initialize the MongoDB transaction store.
   */
  public async initialize (): Promise<void> {
    const client = await MongoClient.connect(this.serverUrl);
    this.db = client.db(this.databaseName);
    this.transactionCollection = await MongoDbTransactionStore.createTransactionCollectionIfNotExist(this.db);
    this.unresolvableTransactionCollection = await MongoDbTransactionStore.createUnresolvableTransactionCollectionIfNotExist(this.db);
  }

  /**
   * Empties both `transaction` and `unresolvable-transactions`.
   */
  public async emptyCollections () {
    await this.transactionCollection!.drop();
    await this.unresolvableTransactionCollection!.drop();

    this.unresolvableTransactionCollection = await MongoDbTransactionStore.createUnresolvableTransactionCollectionIfNotExist(this.db!);
    this.transactionCollection = await MongoDbTransactionStore.createTransactionCollectionIfNotExist(this.db!);
  }

  async addProcessedTransaction (transaction: Transaction): Promise<void> {
    try {
      await this.transactionCollection!.insertOne(transaction);
    } catch (error) {
      // Swallow duplicate insert errors (error code 11000) as no-op; rethrow others
      if (error.code !== 11000) {
        throw error;
      }
    }
  }

  async getLastTransaction (): Promise<Transaction | undefined> {
    const lastTransactions = await this.transactionCollection!.find().limit(1).sort({ transactionTime: -1, transactionNumber: -1 }).toArray();
    if (lastTransactions.length === 0) {
      return undefined;
    }

    const lastProcessedTransaction = lastTransactions[0];
    return lastProcessedTransaction;
  }

  async getExponentiallySpacedTransactions (): Promise<Transaction[]> {
    const exponentiallySpacedTransactions: Transaction[] = [];
    const allTransactions = await this.transactionCollection!.find().sort({ transactionTime: 1, transactionNumber: 1 }).toArray();

    let index = allTransactions.length - 1;
    let distance = 1;
    while (index >= 0) {
      exponentiallySpacedTransactions.push(allTransactions[index]);
      index -= distance;
      distance *= 2;
    }
    return exponentiallySpacedTransactions;
  }

  async recordUnresolvableTransactionFetchAttempt (transaction: Transaction): Promise<void> {
    // Try to get the unresolvable transaction from store.
    const transactionTime = transaction.transactionTime;
    const transactionNumber = transaction.transactionNumber;
    const findResults = await this.unresolvableTransactionCollection!.find({ transactionTime, transactionNumber }).toArray();
    let unresolvableTransaction: IUnresolvableTransaction | undefined;
    if (findResults && findResults.length > 0) {
      unresolvableTransaction = findResults[0];
    }

    // If unresolvable transaction not found in store, insert a new one; else update the info on retry attempts.
    if (unresolvableTransaction === undefined) {
      const newUnresolvableTransaction = {
        transactionTime,
        transactionNumber,
        anchorFileHash: transaction.anchorFileHash,
        transactionTimeHash: transaction.transactionTimeHash,
        firstFetchTime: Date.now(),
        retryAttempts: 0,
        nextRetryTime: Date.now()
      };

      await this.unresolvableTransactionCollection!.insertOne(newUnresolvableTransaction);
    } else {
      const retryAttempts = unresolvableTransaction.retryAttempts + 1;

      // Exponentially delay the retry the more attempts are done in the past.
      const requiredElapsedTimeSinceFirstFetchBeforeNextRetry = Math.pow(2, unresolvableTransaction.retryAttempts) * this.exponentialDelayFactorInMilliseconds;
      const requiredElapsedTimeInSeconds = requiredElapsedTimeSinceFirstFetchBeforeNextRetry / 1000;
      console.info(`Required elapsed time before retry for anchor file ${transaction.anchorFileHash} is now ${requiredElapsedTimeInSeconds} seconds.`);
      const nextRetryTime = unresolvableTransaction.firstFetchTime + requiredElapsedTimeSinceFirstFetchBeforeNextRetry;

      await this.unresolvableTransactionCollection!.updateOne({ transactionTime, transactionNumber }, { $set: { retryAttempts, nextRetryTime } });
    }
  }

  async removeUnresolvableTransaction (transaction: Transaction): Promise<void> {
    const transactionTime = transaction.transactionTime;
    const transactionNumber = transaction.transactionNumber;
    await this.unresolvableTransactionCollection!.deleteOne({ transactionTime, transactionNumber });
  }

  async getUnresolvableTransactionsDueForRetry (maximumReturnCount?: number): Promise<Transaction[]> {
    // Override the return count if it is specified.
    let returnCount = this.maximumUnresolvableTransactionReturnCount;
    if (maximumReturnCount !== undefined) {
      returnCount = maximumReturnCount;
    }

    const now = Date.now();
    const unresolvableTransactionsToRetry
      = await this.unresolvableTransactionCollection!.find({ nextRetryTime: { $lte: now } }).sort({ nextRetryTime: 1 }).limit(returnCount).toArray();

    return unresolvableTransactionsToRetry;
  }

  async removeTransactionsLaterThan (transactionNumber?: number): Promise<void> {
    // If given `undefined`, remove all transactions.
    if (transactionNumber === undefined) {
      await this.emptyCollections();
      return;
    }

    await this.unresolvableTransactionCollection!.deleteMany({ transactionNumber: { $gt: transactionNumber } });
    await this.transactionCollection!.deleteMany({ transactionNumber: { $gt: transactionNumber } });
  }

  /**
   * Gets the list of processed transactions.
   * Mainly used for test purposes.
   */
  public async getProcessedTransactions (): Promise<Transaction[]> {
    const transactions = await this.transactionCollection!.find().sort({ transactionTime: 1, transactionNumber: 1 }).toArray();
    return transactions;
  }

  /**
   * Gets the list of unresolvable transactions.
   * Mainly used for test purposes.
   */
  public async getUnresolvableTransactions (): Promise<IUnresolvableTransaction[]> {
    const transactions = await this.unresolvableTransactionCollection!.find().sort({ transactionTime: 1, transactionNumber: 1 }).toArray();
    return transactions;
  }

  /**
   * Creates the `transaction` collection with indexes if it does not exists.
   * @returns The existing collection if exists, else the newly created collection.
   */
  public static async createTransactionCollectionIfNotExist (db: Db): Promise<Collection<Transaction>> {
    const collections = await db.collections();
    const collectionNames = collections.map(collection => collection.collectionName);

    // If 'transactions' collection exists, use it; else create it.
    let transactionCollection;
    if (collectionNames.includes(MongoDbTransactionStore.transactionCollectionName)) {
      console.info('Transaction collection already exists.');
      transactionCollection = db.collection(MongoDbTransactionStore.transactionCollectionName);
    } else {
      console.info('Transaction collection does not exists, creating...');
      transactionCollection = await db.createCollection(MongoDbTransactionStore.transactionCollectionName);
      // This is an unique index, so duplicate inserts are rejected.
      await transactionCollection.createIndex({ transactionTime: 1, transactionNumber: 1 }, { unique: true });
      console.info('Transaction collection created.');
    }

    return transactionCollection;
  }

  /**
   * Creates the `unresolvable-transaction` collection with indexes if it does not exists.
   * @returns The existing collection if exists, else the newly created collection.
   */
  public static async createUnresolvableTransactionCollectionIfNotExist (db: Db): Promise<Collection<IUnresolvableTransaction>> {
    const collections = await db.collections();
    const collectionNames = collections.map(collection => collection.collectionName);

    // If 'unresolvable transactions' collection exists, use it; else create it.
    let unresolvableTransactionCollection;
    if (collectionNames.includes(MongoDbTransactionStore.unresolvableTransactionCollectionName)) {
      console.info('Unresolvable transaction collection already exists.');
      unresolvableTransactionCollection = db.collection(MongoDbTransactionStore.unresolvableTransactionCollectionName);
    } else {
      console.info('Unresolvable transaction collection does not exists, creating...');
      unresolvableTransactionCollection = await db.createCollection(MongoDbTransactionStore.unresolvableTransactionCollectionName);
      await unresolvableTransactionCollection.createIndex({ transactionTime: 1, transactionNumber: 1 }, { unique: true });
      await unresolvableTransactionCollection.createIndex({ nextRetryTime: 1 });
      console.info('Unresolvable transaction collection created.');
    }

    return unresolvableTransactionCollection;
  }

}
