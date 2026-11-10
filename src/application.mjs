/**
 * The Boundry Intel FeltDB application: one state contract over every collection this system owns.
 *
 * FeltDB governs a store with exactly one application contract — evolving a second is refused
 * (`this store is governed by contract …; it cannot be replaced by …`), and writing a collection the active contract
 * does not declare is refused too (both verified against the local runtime, `test/integration.test.mjs`). So the
 * registry, the publisher directory and the event store are not three contracts: they are three sets of collections in
 * one application, composed here and nowhere else.
 *
 * Each module still owns what its own collections mean and declares their fields and indexes; this module only joins
 * them and names the application. That keeps one source of truth per collection and one source of truth for the
 * contract the authority enforces.
 *
 * | Collections                                     | Module               | Holds                                      |
 * |-------------------------------------------------|----------------------|--------------------------------------------|
 * | `registry_records`, `registry_revisions`        | `store.mjs`          | `boundry.registry/1` documents and history |
 * | `intel_publishers`                              | `publishers.mjs`     | publisher identities (hash only, no key)   |
 * | `intel_events`                                  | `acceptance.mjs`     | accepted `boundry.event/1` envelopes       |
 */
import { defineStateContract } from '@feltdb/core';

import { REGISTRY_COLLECTION_SPEC } from './store.mjs';
import { PUBLISHER_COLLECTION_SPEC } from './publishers.mjs';
import { EVENT_COLLECTION_SPEC } from './acceptance.mjs';

export const APPLICATION_NAME = 'boundry-intel';
export const APPLICATION_VERSION = 1;

/** Every collection of the Boundry Intel application, with the field and index declarations of its owning module. */
export const BOUNDRY_INTEL_CONTRACT = Object.freeze({
  name: APPLICATION_NAME,
  version: APPLICATION_VERSION,
  collections: Object.freeze({ ...REGISTRY_COLLECTION_SPEC, ...PUBLISHER_COLLECTION_SPEC, ...EVENT_COLLECTION_SPEC }),
});

export const boundryIntelStateContract = () => defineStateContract(BOUNDRY_INTEL_CONTRACT);

/**
 * Installs the application contract on `db`, once. Returns true when it was installed, false when the store already
 * had it: a store governed by a different contract throws, because that store belongs to another application and
 * silently taking it over would be the opposite of a durable home for this data.
 */
export async function prepare(db) {
  if (await db.stateContract.active()) return false;
  await db.stateContract.evolve(boundryIntelStateContract());
  return true;
}
