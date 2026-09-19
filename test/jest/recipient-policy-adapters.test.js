import { expect, it, jest } from '@jest/globals';
import { MongoQueue } from '../../adapters/mongo.js';
import { BlankQueue } from '../../adapters/blank-example.js';

const makeMongo = () => {
  const collection = {
    createIndex: jest.fn(async () => {}),
    find: jest.fn(() => ({ hasNext: async () => false, close: async () => {} })),
    findOne: jest.fn(async () => ({ _id: 'id', uuid: 'u', isSent: false, isCancelled: false })),
    updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 0 })),
    deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
  };
  const queue = new MongoQueue({ db: { collection: () => collection }, prefix: 'policy' });
  queue.mailTimeInstance = { maxTries: 2, sendingTimeout: 300000, keepHistory: true };
  return { queue, collection };
};

it('Mongo accepts unchanged guarded checkpoints and excludes settled writes', async () => {
  const { queue, collection } = makeMongo();
  expect(queue.supportsRecipientPolicies).toBe(true);
  const task = { _id: 'id', uuid: 'u', tries: 1 };
  expect(await queue.update(task, { recipientResults: [], leaseTries: 1, leaseSendingAt: 10 })).toBe(true);
  expect(collection.updateOne.mock.calls[0][0]).toMatchObject({ isSettled: { $ne: true }, isSent: false, tries: 1, sendingAt: 10 });
  await queue.remove(task, { leaseTries: 1, leaseSendingAt: 10 });
  expect(collection.deleteOne.mock.calls[0][0]).toMatchObject({ isSettled: { $ne: true }, isSent: false });
});
it('Mongo excludes policy rows from atomic concat and projects result state', async () => {
  const { queue, collection } = makeMongo();
  await queue.getPendingTo('a@example.com', 100);
  expect(collection.findOne.mock.calls[0][0]).toMatchObject({ isSettled: { $ne: true }, recipientResults: { $exists: false } });
  await queue.update({ _id: 'id' }, { appendMailOption: { to: 'a@example.com' } });
  expect(collection.updateOne.mock.calls[0][0]).toMatchObject({ isSettled: { $ne: true }, recipientResults: { $exists: false } });
  await queue.iterate();
  expect(collection.find.mock.calls[0][1].projection).toMatchObject({ isSettled: 1, recipientResults: 1 });
  expect(collection.find.mock.calls[0][0].$and[1].$or[1]).toMatchObject({ recipientResults: { $type: 'array' }, isSending: true });
});
it.each([true, false])('Mongo cancellation is storage guarded with keepHistory=%s', async (keepHistory) => {
  const { queue, collection } = makeMongo();
  queue.mailTimeInstance.keepHistory = keepHistory;
  await queue.cancel('u');
  const query = (keepHistory ? collection.updateOne : collection.deleteOne).mock.calls[0][0];
  expect(query).toMatchObject({ isSettled: { $ne: true }, isSent: false, isCancelled: false });
});
it('custom scaffold declares and demonstrates atomic recipient-state guards', async () => {
  const store = { update: jest.fn(async () => false), remove: jest.fn(async () => false), appendMailOption: jest.fn(async () => false) };
  const queue = new BlankQueue({ requiredOption: store });
  queue.mailTimeInstance = { maxTries: 2 };
  expect(queue.supportsRecipientPolicies).toBe(true);
  expect(await queue.update({ uuid: 'u' }, { recipientResults: [], leaseTries: 1, leaseSendingAt: 10 })).toBe(false);
  expect(store.update.mock.calls[0][0]).toMatchObject({ isSettled: { $ne: true }, tries: 1, sendingAt: 10 });
  expect(store.update.mock.calls[0][1]).not.toHaveProperty('leaseTries');
  await queue.update({ uuid: 'u' }, { appendMailOption: {} });
  expect(store.appendMailOption.mock.calls[0][0]).toMatchObject({ recipientResults: { $exists: false } });
});
