/**
 * Module that implements an AWS enhanced fan-out consumer.
 *
 * @module fan-out-consumer
 * @private
 */

'use strict';

const aws4 = require('aws4');
const got = require('got');
const { CredentialProviderChain } = require('aws-sdk');
const { Parser } = require('lifion-aws-event-stream');
const { Transform, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const { RecordsDecoder } = require('./records');
const { getStreamShards } = require('./stream');
const { reportError, reportResponse } = require('./stats');
const { shouldBailRetry } = require('./utils');

const AWS_API_TARGET = 'Kinesis_20131202.SubscribeToShard';
const AWS_EVENT_STREAM = 'application/vnd.amazon.eventstream';
const AWS_JSON = 'application/x-amz-json-1.1';
const DEFAULT_KINESIS_ENDPOINT = 'https://kinesis.us-east-1.amazonaws.com';
const EXPIRATION_TIMEOUT_OFFSET = 1000;

const asyncPipeline = promisify(pipeline);
const privateData = new WeakMap();
const wait = promisify(setTimeout);

/**
 * Provides access to the private data of the specified instance.
 *
 * @param {object} instance - The private data's owner.
 * @returns {object} The private data.
 * @private
 */
function internal(instance) {
  if (!privateData.has(instance)) {
    privateData.set(instance, {});
  }
  return privateData.get(instance);
}

/**
 * Class that implements a pre-processing stream used as a filter to a stream request to the
 * shard subscription API. If the request is successful and the response is an event stream,
 * chunks are passed to subsequent streams in the pipeline. If the server responds with an error,
 * the error details are parsed and then thrown as an error, which breaks the entire pipeline.
 *
 * @augments external:Transform
 * @memberof module:fan-out-consumer
 * @private
 */
class PreProcess extends Transform {
  /**
   * Initializes an instance of the pre-processing stream.
   *
   * @param {object} options - The initialization options.
   * @param {object} options.requestFlags - The object where the flags for the request are stored.
   * @param {boolean} options.requestFlags.isEventStream - If the request is sucessful and the
   *        headers in the initial response point to an even stream, this flag is set to `true`.
   * @param {number} options.requestFlags.statusCode - The status code of the last request response.
   */
  constructor({ requestFlags }) {
    super({ objectMode: true });
    Object.assign(internal(this), { requestFlags });
  }

  /**
   * The stream transformation logic.
   *
   * @param {Buffer} chunk - A chunk of data coming from the event stream.
   * @param {string} encoding - The stream encoding mode (ignored)
   * @param {Function} callback - The callback for more data.
   */
  _transform(chunk, encoding, callback) {
    const { requestFlags } = internal(this);
    if (!requestFlags.isEventStream) {
      const { statusCode } = requestFlags;
      const { __type, message } = JSON.parse(chunk.toString('utf8'));
      const error = Object.assign(
        new Error(message || 'Failed to subscribe to shard.'),
        { isRetryable: true },
        __type && { code: __type },
        statusCode && { statusCode }
      );
      this.emit('error', error);
    } else {
      this.push(chunk);
    }
    callback();
  }
}

/**
 * Class that implements a post-processing stream used to push records outside the internal
 * stream pipeline. It also stores checkpoints as records arrive, and look for shard depletion.
 *
 * @augments external:Writable
 * @memberof module:fan-out-consumer
 * @private
 */
class PostProcess extends Writable {
  /**
   * Initializes an instance of the post-processing stream.
   *
   * @param {object} options - The initialization options.
   * @param {Function} options.abort - A function that will close the entire pipeline, called
   *        when no data has been pushed through the event stream on a given time window.
   * @param {object} options.logger - An instance of a logger.
   * @param {Function} options.markShardAsDepleted - A function that will mark a given shard as
   *        depleted. Called when a shard depletion event has been detected.
   * @param {Function} options.pushToStream - A function that pushes records out of the pipeline.
   * @param {Function} options.setCheckpoint - A function that stores the checkpoint for the shard.
   * @param {string} options.shardId - The ID of the shard.
   */
  constructor({ abort, logger, markShardAsDepleted, pushToStream, setCheckpoint, shardId }) {
    super({ objectMode: true });
    Object.assign(internal(this), {
      abort,
      logger,
      markShardAsDepleted,
      pushToStream,
      setCheckpoint,
      shardId,
      timeoutId: null
    });
  }

  /**
   * The stream writable logic.
   *
   * @param {object} chunk - A chunk of data coming from the pipeline.
   * @param {string} encoding - The stream encoding mode (ignored)
   * @param {Function} callback - The callback for more data.
   */
  async _write(chunk, encoding, callback) {
    const {
      abort,
      logger,
      markShardAsDepleted,
      pushToStream,
      setCheckpoint,
      shardId,
      timeoutId
    } = internal(this);
    clearTimeout(timeoutId);
    internal(this).timeoutId = setTimeout(abort, 10000);
    const { continuationSequenceNumber, records } = chunk;
    if (continuationSequenceNumber !== undefined) {
      await setCheckpoint(continuationSequenceNumber);
      const recordsCount = records.length;
      const msBehind = chunk.millisBehindLatest;
      if (recordsCount > 0) {
        logger.debug(`Got ${recordsCount} record(s) from "${shardId}" (${msBehind}ms behind)`);
        pushToStream(null, { ...chunk, shardId });
      }
      callback();
    } else {
      markShardAsDepleted();
    }
  }
}

/**
 * Class that implements an AWS enhanced fan-out consumer.
 *
 * @alias module:fan-out-consumer
 */
class FanOutConsumer {
  /**
   * Initializes an instance of an enhanced fan-out consumer.
   *
   * @param {object} options - The initialization options.
   * @param {object} options.awsOptions - The AWS.Kinesis options to use in the HTTP request.
   * @param {string} options.checkpoint - The last-known checkpoint for the stream shard.
   * @param {object} options.client - An instance of the Kinesis client.
   * @param {string} options.compression - The kind of data compression to use with records.
   * @param {string} options.consumerArn - The ARN of the enhanced consumer as registered in AWS.
   * @param {string} options.leaseExpiration - The timestamp of the shard lease expiration.
   * @param {object} options.logger - An instance of a logger.
   * @param {Function} options.pushToStream - A function to push incoming records to the consumer.
   * @param {string} options.shardId - The ID of the stream shard to subscribe for records.
   * @param {object} options.stateStore - An instance of the state store.
   * @param {Function} options.stopConsumer - A function that stops this consumer from the manager.
   * @param {string} options.streamName - The name of the Kinesis stream.
   */
  constructor(options) {
    const {
      awsOptions,
      checkpoint,
      client,
      compression,
      consumerArn,
      leaseExpiration,
      logger,
      pushToStream,
      shardId,
      stateStore,
      stopConsumer,
      streamName
    } = options;

    const { endpoint = DEFAULT_KINESIS_ENDPOINT, region } = awsOptions;
    const credentialsChain = new CredentialProviderChain();

    const signRequest = async requestOptions => {
      let { accessKeyId, secretAccessKey, sessionToken } = awsOptions;
      if (!accessKeyId && !secretAccessKey && !sessionToken) {
        ({ accessKeyId, secretAccessKey, sessionToken } = await credentialsChain.resolvePromise());
      }
      aws4.sign(requestOptions, { accessKeyId, secretAccessKey, sessionToken });
    };

    const httpClient = got.extend({
      baseUrl: endpoint,
      headers: { 'Content-Type': AWS_JSON },
      hooks: { beforeRequest: [signRequest] },
      region,
      throwHttpErrors: false
    });

    Object.assign(internal(this), {
      checkpoint,
      client,
      compression,
      consumerArn,
      expirationTimeoutId: null,
      httpClient,
      leaseExpiration,
      logger,
      pushToStream,
      request: null,
      retryPipeline: true,
      shardId,
      stateStore,
      stopConsumer,
      streamName
    });
  }

  /**
   * Starts the enhanced fan-out consumer by initializing the internal stream pipeline.
   *
   * @fulfil {undefined}
   * @returns {Promise}
   */
  async start() {
    const privateProps = internal(this);
    const {
      client,
      compression,
      consumerArn,
      httpClient,
      leaseExpiration,
      logger,
      pushToStream,
      shardId,
      stateStore,
      stopConsumer,
      streamName
    } = privateProps;

    logger.debug(`Starting an enhanced fan-out subscriber for shard "${shardId}"…`);

    this.updateLeaseExpiration(leaseExpiration);

    const { shardsPath, shardsPathNames } = await stateStore.getShardsData();

    const requestFlags = {};
    let stream;

    const handleRequest = req => {
      privateProps.request = req;
    };

    const handleResponse = async res => {
      const { headers, statusCode } = res;
      requestFlags.statusCode = statusCode;
      if (headers['content-type'] !== AWS_EVENT_STREAM || statusCode !== 200) {
        logger.error(`Subscription unsuccessful: ${statusCode}`);
        requestFlags.isEventStream = false;
        reportError('kinesis', { statusCode }, streamName);
      } else {
        logger.debug('Subscription to shard is successful.');
        requestFlags.isEventStream = true;
        reportResponse('kinesis', streamName);
      }
    };

    const markShardAsDepleted = async () => {
      const shards = await getStreamShards({ client, logger, streamName });
      logger.debug(`The parent shard "${shardId}" has been depleted.`);
      await stateStore.markShardAsDepleted(shards, shardId);
      stopConsumer(shardId);
    };

    const setCheckpoint = async sequenceNumber => {
      await stateStore.storeShardCheckpoint(shardId, sequenceNumber, shardsPath, shardsPathNames);
      privateProps.checkpoint = sequenceNumber;
    };

    const abort = () => {
      if (privateProps.request) {
        privateProps.request.abort();
      }
    };

    do {
      if (requestFlags.isEventStream === false) {
        logger.warn(`Waiting before retrying the pipeline…`);
        await wait(5000);
      }

      const { checkpoint } = privateProps;

      stream = httpClient.stream('/', {
        body: JSON.stringify({
          ConsumerARN: consumerArn,
          ShardId: shardId,
          StartingPosition: Object.assign(
            { Type: checkpoint ? 'AFTER_SEQUENCE_NUMBER' : 'LATEST' },
            checkpoint && { SequenceNumber: checkpoint }
          )
        }),
        headers: { 'X-Amz-Target': AWS_API_TARGET },
        service: 'kinesis'
      });

      stream.on('request', handleRequest);
      stream.on('response', handleResponse);

      try {
        await asyncPipeline([
          stream,
          new PreProcess({ requestFlags }),
          new Parser(),
          new RecordsDecoder({ compression }),
          new PostProcess({
            abort,
            logger,
            markShardAsDepleted,
            pushToStream,
            setCheckpoint,
            shardId
          })
        ]);
      } catch (err) {
        const { code, message, requestId, statusCode } = err;
        if (!shouldBailRetry(err)) {
          logger.warn(
            [
              'Trying to recover from AWS.Kinesis error…',
              `- Message: ${message}`,
              `- Request ID: ${requestId}`,
              `- Code: ${code} (${statusCode})`,
              `- Stream: ${streamName}`
            ].join('\n\t')
          );
        } else {
          pushToStream(err);
          logger.error(`Pipeline closed with error: [${code}] ${message}`);
          privateProps.retryPipeline = false;
        }
      }
    } while (privateProps.retryPipeline);

    abort();
  }

  /**
   * Stops the internal stream pipeline.
   */
  stop() {
    const privateProps = internal(this);
    const { expirationTimeoutId, request } = privateProps;
    if (request) {
      request.abort();
      privateProps.request = null;
      privateProps.retryPipeline = false;
    }
    clearTimeout(expirationTimeoutId);
    privateProps.expirationTimeoutId = null;
  }

  /**
   * Updates the shard lease expiration timestamp.
   *
   * @param {string} leaseExpiration - The updated timestamp when the shard lease expires.
   */
  updateLeaseExpiration(leaseExpiration) {
    const privateProps = internal(this);
    const { expirationTimeoutId, logger, shardId, stopConsumer } = privateProps;

    privateProps.leaseExpiration = leaseExpiration;

    clearTimeout(expirationTimeoutId);
    privateProps.expirationTimeoutId = null;

    const delay = new Date(leaseExpiration).getTime() - Date.now() - EXPIRATION_TIMEOUT_OFFSET;
    if (delay < 0) {
      return;
    }

    privateProps.expirationTimeoutId = setTimeout(() => {
      logger.debug(`The lease for "${shardId}" has expired.`);
      stopConsumer(shardId);
    }, delay);
  }
}

/**
 * @external Transform
 * @see https://nodejs.org/dist/latest-v10.x/docs/api/stream.html#stream_class_stream_transform
 */

/**
 * @external Writable
 * @see https://nodejs.org/dist/latest-v10.x/docs/api/stream.html#stream_class_stream_writable
 */

module.exports = FanOutConsumer;
