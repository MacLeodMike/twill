// The registry's embeddable surface — for consumers that boot a registry
// in-process (twill-pi's integration test, embedders). The CLI is separate
// (the `twill` bin). This is the `./registry` export of @bitwise-operations/twill.

export { start, type RegistryStore } from "./store.js";
export { createServer } from "./server.js";
export type { Route } from "./document.js";
