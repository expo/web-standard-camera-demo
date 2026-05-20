// @ref LLP 0002#gum-error-mapping — DOMException polyfill with `name` and the
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

export function rewrapNativeError(e: unknown): never {
  if (e instanceof Error) {
    const name = (e as { name?: string }).name ?? 'Error';
    let constraint: string | undefined;
    if (name === 'OverconstrainedError' && typeof e.message === 'string') {
      const idx = e.message.indexOf(CONSTRAINT_PREFIX);
      if (idx >= 0) {
        constraint = e.message.slice(idx + CONSTRAINT_PREFIX.length).trim();
      }
    }
    throw new DOMException(e.message, name, constraint);
  }
  throw new DOMException(String(e), 'UnknownError');
}
