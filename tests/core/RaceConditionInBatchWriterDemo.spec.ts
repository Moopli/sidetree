import BatchWriter from '../../lib/core/versions/latest/BatchWriter';
import Cryptography from '../../lib/core/versions/latest/util/Cryptography';
import ICas from '../../lib/core/interfaces/ICas';
import KeyUsage from '../../lib/core/versions/latest/KeyUsage';
import MockBlockchain from '../mocks/MockBlockchain';
import MockCas from '../mocks/MockCas';
import MockOperationQueue from '../mocks/MockOperationQueue';
import OperationGenerator from '../generators/OperationGenerator';
import Operation from '../../lib/core/versions/latest/Operation';
import IOperationQueue from '../../lib/core/versions/latest/interfaces/IOperationQueue';

describe('RequestHandler', () => {
  // Load the DID Document template.
  const didDocumentTemplate = require('../json/didDocumentTemplate.json');
  const blockchain = new MockBlockchain();
  let cas: ICas;
  let batchWriter: BatchWriter;
  let operationQueue: IOperationQueue;

  beforeEach(async () => {
    operationQueue = new MockOperationQueue();
    spyOn(blockchain, 'getFee').and.returnValue(Promise.resolve(100));
    cas = new MockCas();
    batchWriter = new BatchWriter(operationQueue, blockchain, cas, 0);
    // Set a latest time that must be able to resolve to a protocol version in the protocol config file used.
  });

  fit('should show that a race condition is possible', async () => {
    // Generate two create payloads
    const [publicKey1, privateKey1] = await Cryptography.generateKeyPairHex('#key1', KeyUsage.recovery);
    const createOperationBuffer1 = await OperationGenerator.generateCreateOperationBuffer(didDocumentTemplate, publicKey1, privateKey1);
    const operation1 = Operation.create(createOperationBuffer1);
    const [publicKey2, privateKey2] = await Cryptography.generateKeyPairHex('#key1', KeyUsage.recovery);
    const createOperationBuffer2 = await OperationGenerator.generateCreateOperationBuffer(didDocumentTemplate, publicKey2, privateKey2);
    const operation2 = Operation.create(createOperationBuffer2);

    // Queue operation 2 write after BatchWriter.write() is called
    setTimeout(async () => {
      await operationQueue.enqueue(operation2.didUniqueSuffix, operation2.operationBuffer);
    }, 100);

    // Queue operation 1 and call BatchWriter.write()
    await operationQueue.enqueue(operation1.didUniqueSuffix, operation1.operationBuffer);
    await batchWriter.write();

    // Operation 1 was anchored but operation 2 was dequeued instead of operation 1
    const queue = await operationQueue.peek(1);
    const operationInQueue = Operation.create(queue[0]);
    expect(operationInQueue.operationHash).toBe(operation1.operationHash);
  });
});
