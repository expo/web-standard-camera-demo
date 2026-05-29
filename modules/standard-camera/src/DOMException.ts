// @ref LLP 0003#gum-error-mapping — DOMException polyfill with `name` and the
// OverconstrainedError-specific `constraint` field

export class DOMException extends Error {
  readonly name: string;
  readonly constraint?: string;

  constructor(message: string, name: string, constraint?: string) {
    super(message);
    this.name = name;
    if (constraint !== undefined) {
      this.constraint = constraint;
    }
  }
}

// Some ports use `error.constraint` for OverconstrainedError; we parse from
// the native exception message of the form "Constraint cannot be satisfied: <name>".
const CONSTRAINT_PREFIX = 'Constraint cannot be satisfied: ';

// Native errors arrive with the spec name encoded as a "[<Name>] <message>"
// prefix on the description, because Expo Modules Core (SDK 56) strips the
// Swift `Exception.name` from the JS-side error. See `spec(...)` in
// MediaDevices.swift.
const NAME_PREFIX_REGEXP = /^\[([A-Za-z]+Error|TypeError)\]\s*/;

export function rewrapNativeError(e: unknown): never {
  if (e instanceof Error) {
    const errLike = e as { name?: string; code?: string };
    let name = errLike.name ?? 'Error';
    let message = e.message;

    const match = typeof message === 'string' ? message.match(NAME_PREFIX_REGEXP) : null;
    if (match) {
      name = match[1];
      message = message.slice(match[0].length);
    } else {
      // Fall back: some Expo SDKs do propagate the spec name on `.code`.
      const code = errLike.code;
      if (typeof code === 'string' && code !== '' && code !== 'Error' && !code.startsWith('ERR_')) {
        name = code;
      }
    }

    if (name === 'TypeError') {
      // WPT tests use `assert_throws_js(TypeError, ...)` which checks
      // `instanceof TypeError`. Throw the real JS class, not a DOMException.
      throw new TypeError(message);
    }

    let constraint: string | undefined;
    if (name === 'OverconstrainedError' && typeof message === 'string') {
      const idx = message.indexOf(CONSTRAINT_PREFIX);
      if (idx >= 0) {
        constraint = message.slice(idx + CONSTRAINT_PREFIX.length).trim();
      }
    }
    throw new DOMException(message, name, constraint);
  }
  throw new DOMException(String(e), 'UnknownError');
}
