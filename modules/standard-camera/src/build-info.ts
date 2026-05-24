// Per-evaluation timestamp captured the first time this module is imported.
// Used by the Diagnostics tab to answer "did the JS bundle just reload?" —
// changes whenever a fresh bundle is evaluated, including a Metro hot reload
// or a swap between the embedded bundle and a Metro-served one. Combined with
// the native executable mtime, this tells us whether we're running fresh JS
// against a fresh binary, fresh JS against a stale binary, or a stale
// embedded bundle against either.
export const JS_LOAD_TIME = Date.now();
