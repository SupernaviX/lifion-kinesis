'use strict';

const { DynamoDB, mockClear } = require('aws-sdk');
const { reportError, reportResponse } = require('./stats');
const DynamoDbClient = require('./dynamodb-client');
const { getStackObj } = require('./utils');

jest.mock('./stats');

jest.mock('./utils', () => {
  const utils = jest.requireActual('./utils');
  return { ...utils, getStackObj: jest.fn((...args) => utils.getStackObj(...args)) };
});

describe('lib/dynamodb-client', () => {
  const warn = jest.fn();
  const logger = { warn };
  let client;
  let error;
  let sdkClient;

  function recreateClients(isDocClient) {
    client = new DynamoDbClient({ logger });
    sdkClient = isDocClient ? new DynamoDB.DocumentClient() : new DynamoDB();
  }

  function throwErrorImplementation() {
    throw error;
  }

  function rejectedPromiseImplementation() {
    return { promise: () => Promise.reject(error) };
  }

  afterEach(() => {
    warn.mockClear();
    reportError.mockClear();
    reportResponse.mockClear();
    getStackObj.mockClear();
  });

  test('the module exports the expected', () => {
    expect(DynamoDbClient).toEqual(expect.any(Function));
    expect(DynamoDbClient).toThrow('Class constructor');
    expect(Object.getOwnPropertyNames(DynamoDbClient.prototype)).toEqual([
      'constructor',
      'createTable',
      'describeTable',
      'listTagsOfResource',
      'tagResource',
      'waitFor',
      'delete',
      'get',
      'put',
      'update'
    ]);
  });

  test('new instances of the module wrap instances of AWS.DynamoDB', () => {
    const awsOptions = { foo: 'bar' };
    client = new DynamoDbClient({ awsOptions });
    expect(client).toBeDefined();
    expect(DynamoDB).toHaveBeenCalledWith(awsOptions);
  });

  describe.each`
    methodName              | isDocClient | isRetriable
    ${'createTable'}        | ${false}    | ${false}
    ${'delete'}             | ${true}     | ${false}
    ${'describeTable'}      | ${false}    | ${true}
    ${'get'}                | ${true}     | ${true}
    ${'listTagsOfResource'} | ${false}    | ${true}
    ${'put'}                | ${true}     | ${true}
    ${'tagResource'}        | ${false}    | ${false}
    ${'update'}             | ${true}     | ${true}
    ${'waitFor'}            | ${false}    | ${true}
  `('$methodName', ({ isDocClient, isRetriable, methodName }) => {
    beforeEach(() => {
      mockClear();
      recreateClients(isDocClient);
    });

    test(`${methodName} calls the wrapped AWS SDK method`, async () => {
      const params = { foo: 'bar' };
      await client[methodName](params);
      expect(sdkClient[methodName]).toHaveBeenCalledWith(params);
      expect(reportResponse).toHaveBeenCalledWith('dynamoDb');
    });

    test(`${methodName} throws exceptions from the wrapped SDK call`, async () => {
      error = Object.assign(new Error('foo'), { code: 'MissingRequiredParameter' });
      sdkClient[methodName].mockImplementationOnce(throwErrorImplementation);
      await expect(client[methodName]({})).rejects.toThrow(error);
      expect(reportError).toHaveBeenCalledWith('dynamoDb', error);
      expect(warn).not.toHaveBeenCalled();
    });

    test(`${methodName} throws exceptions from the wrapped SDK promise`, async () => {
      error = Object.assign(new Error('foo'), { code: 'MissingRequiredParameter' });
      sdkClient[methodName].mockImplementationOnce(rejectedPromiseImplementation);
      await expect(client[methodName]({})).rejects.toThrow(error);
      expect(reportError).toHaveBeenCalledWith('dynamoDb', error);
      expect(warn).not.toHaveBeenCalled();
    });

    test(`${methodName} throws exceptions with a debuggable stack trace`, async () => {
      error = Object.assign(new Error('foo'), { code: 'MissingRequiredParameter' });
      sdkClient[methodName].mockImplementationOnce(rejectedPromiseImplementation);
      const stackBefore = await client[methodName]({}).catch(err => err.stack);

      recreateClients(isDocClient);
      sdkClient[methodName].mockImplementationOnce(rejectedPromiseImplementation);
      getStackObj.mockReturnValueOnce({ stack: '\n' });
      const stackAfter = await client[methodName]({}).catch(err => err.stack);

      expect(stackBefore).not.toEqual(stackAfter);
    });

    if (isRetriable) {
      test(`${methodName} retries errors from the wrapped SDK`, async () => {
        error = new Error('foo');
        sdkClient[methodName].mockImplementationOnce(rejectedPromiseImplementation);
        const promise = client[methodName]({});
        await expect(promise).resolves.toEqual({});
        expect(sdkClient[methodName]).toHaveBeenCalledTimes(2);
        expect(reportError).toHaveBeenCalledWith('dynamoDb', error);
        expect(warn).toHaveBeenCalled();
      });
    }
  });
});
