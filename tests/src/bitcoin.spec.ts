// MUST set this environment variable before `blockchainService` and `server` are imported.
process.env.SIDETREE_TEST_MODE = 'true';

import * as supertest from 'supertest';
import RequestError, { ErrorCode } from '../../lib/core/util/RequestError';
import { blockchainService, server } from '../../src/bitcoin';
import { ResponseStatus } from '../../lib/core/Response';

describe('Bitcoin service', async () => {
  it('should return 400 with error code when transaction fecth throws invalid hash error.', async () => {
    const fakeGetTransactionsMethod = async () => { throw new RequestError(ResponseStatus.BadRequest, ErrorCode.InvalidTransactionNumberOrTimeHash); };
    spyOn(blockchainService, 'transactions').and.callFake(fakeGetTransactionsMethod);

    const response = await supertest(server).get('/transactions?since=6212927891701761&transaction-time-hash=dummyHash');

    expect(response.status).toEqual(400);

    const actualResponseBody = JSON.parse(response.body.toString());
    expect(actualResponseBody).toBeDefined();
    expect(actualResponseBody.code).toEqual(ErrorCode.InvalidTransactionNumberOrTimeHash);
  });
});