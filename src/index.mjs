/**
 * Boundry Intel: the durable foundation for Boundry's understanding of its own products, repositories, integrations
 * and the events they report.
 *
 * - `boundry.registry/1` (`contract.mjs`): products, versions, repositories, capabilities, integration identities and
 *   the explicit relationships between them, each with provenance.
 * - `boundry.event/1` (`events.mjs`): the versioned envelope a product reports, migrated from rkendel1/boundry.
 * - The registry store, the publisher directory and event acceptance, over one FeltDB application contract.
 */
export * from './contract.mjs';
export { RegistryStore, REGISTRY_COLLECTION_SPEC, COLLECTIONS, recordKey } from './store.mjs';
export { productProjection, repositoryProjection, capabilityProjection, integrationProjection, journey, snapshot } from './projections.mjs';
export { APPLICATION_NAME, APPLICATION_VERSION, BOUNDRY_INTEL_CONTRACT, boundryIntelStateContract, prepare } from './application.mjs';
export {
  PublisherDirectory,
  PUBLISHER_COLLECTIONS,
  PUBLISHER_COLLECTION_SPEC,
  PUBLISHER_SCOPES,
  PUBLISHER_SUBJECT_KINDS,
  authorizes,
} from './publishers.mjs';
export { EventAcceptor, EVENT_COLLECTIONS, EVENT_COLLECTION_SPEC, MAX_BATCH, eventKey } from './acceptance.mjs';
export {
  EVENT_SCHEMA,
  SUPPORTED_EVENT_SCHEMAS,
  EVENT_TYPES,
  DISCOVERY_CHANNELS,
  OUTCOME_STATUSES,
  COUNTERS,
  ACTOR_ATTRIBUTES,
  ACTOR_DISCLOSURE_STATUSES,
  IDENTITY_CLASSES,
  CONFIDENCE_LEVELS,
  validateEvent,
  eventDigest,
  attribute,
  feedbackIdsOf,
} from './events.mjs';
