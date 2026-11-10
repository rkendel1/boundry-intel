/**
 * Writes `boundry-intel.contract.json`: the managed-authority form of the same contract the local tests enforce.
 *
 * Generated rather than hand-written, so the published shape and `src/application.mjs` cannot drift. Each collection
 * carries a policy with no read and no write subject, which grants end-user sessions nothing: this service is the
 * only reader and writer, through its own data-plane service key. Event records and publisher key hashes must never
 * be reachable from a browser session.
 */
import { writeFileSync } from 'node:fs';

import { toManagedContract } from '@feltdb/core';

import { BOUNDRY_INTEL_CONTRACT, boundryIntelStateContract } from '../src/application.mjs';

const policies = Object.keys(BOUNDRY_INTEL_CONTRACT.collections).map((collection) => ({ name: `${collection}-service-only`, resource: collection, capabilities: [] }));
const managed = toManagedContract(boundryIntelStateContract(), { policies });
writeFileSync(new URL('../boundry-intel.contract.json', import.meta.url), `${JSON.stringify(managed, null, 2)}\n`);
process.stdout.write(`${managed.collections.length} collections, ${managed.indexes.length} indexes, ${managed.policies.length} policies -> boundry-intel.contract.json\n`);
