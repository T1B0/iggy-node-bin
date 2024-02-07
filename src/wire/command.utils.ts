
import type { CommandResponse, RawClient } from '../client/client.type.js';

export type ArgTypes<F extends Function> = F extends (...args: infer A) => any ? A : never;

export type Command<I, O> = {
  code: number,
  serialize: (args: I) => Buffer,
  deserialize: (r: CommandResponse) => O
}

export function wrapCommand<I, O>(cmd: Command<I, O>) {
  return (client: RawClient) =>
    async (arg: I) => cmd.deserialize(
      await client.sendCommand(cmd.code, cmd.serialize(arg))
    );
};
