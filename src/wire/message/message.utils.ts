
import { uint32ToBuf } from '../number.utils.js';
import { serializeHeaders, type Headers } from './header.utils.js';
import { serializeIdentifier, type Id } from '../identifier.utils.js';
import { serializePartitioning, type Partitioning } from './partitioning.utils.js';
import { serializeUUID } from '../serialize.utils.js';

export type CreateMessage = {
  id: string, // uuid
  headers?: Headers,
  payload: string | Buffer
};

export const serializeMessage = (msg: CreateMessage) => {
  const { id, headers, payload } = msg;
  const bId = serializeUUID(id);
  const bHeaders = serializeHeaders(headers);
  const bPayload = 'string' === typeof payload ? Buffer.from(payload) : payload

  console.log('MSG::id', id, bId.toString('hex'));
  console.log('MSG::headers', headers, bHeaders.toString('hex'));
  console.log('MSG::payload', `"${payload}"`, bPayload.toString('hex'));

  return Buffer.concat([
    bId,
    bHeaders, // size included
    uint32ToBuf(bPayload.length),
    bPayload
  ]);
};

export const serializeMessages = (messages: CreateMessage[]) => messages.reduce(
  (ac, c) => Buffer.concat([ac, serializeMessage(c)]),
  Buffer.alloc(0)
);

export const serializeSendMessages = (
  streamId: Id,
  topicId: Id,
  messages: CreateMessage[],
  partitioning?: Partitioning,
) => {
  const streamIdentifier = serializeIdentifier(streamId);
  const topicIdentifier = serializeIdentifier(topicId);
  const bPartitioning = serializePartitioning(partitioning);
  const bMessages = serializeMessages(messages);

  console.log('SM::streamId', streamId, streamIdentifier.toString('hex'));
  console.log('SM::topicId', topicId, topicIdentifier.toString('hex'));
  console.log('SM::partitioning', partitioning, bPartitioning.toString('hex'));

  return Buffer.concat([
    streamIdentifier,
    topicIdentifier,
    bPartitioning,
    bMessages
  ]);
};
