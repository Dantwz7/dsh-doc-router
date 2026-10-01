/**
 * Stand-in for `@deepseek-ai/schemastery`.
 *
 * Models exactly one feature of the real library: a field factory that accepts
 * `.default(value)`, and `object()` returning a callable schema that applies
 * those defaults. That is enough for `Config({})` to behave the way DSH makes
 * it behave at load time, which is what the unit tests assert.
 *
 * Deliberately NOT modelled: validation, coercion, unknown-key stripping,
 * `volatile`, nested schemas. Do not grow this into a reimplementation — the
 * real schema is exercised by `tests/manual/real-api.mjs` against `app.asar`.
 */

function makeField(fallback) {
    const field = (value) => (value === undefined ? fallback : value);
    field.default = (value) => makeField(value);
    field.__fallback = fallback;
    return field;
}

export default {
    object: (shape) => {
        const schema = (input = {}) =>
            Object.fromEntries(
                Object.entries(shape).map(([key, field]) => [key, field(input[key])]),
            );
        schema.__shape = shape;
        return schema;
    },
    string: () => makeField(undefined),
    number: () => makeField(undefined),
    boolean: () => makeField(undefined),
    array: () => makeField([]),
    dict: () => makeField({}),
    any: () => makeField(undefined),
    const: (value) => makeField(value),
    union: () => makeField(undefined),
};
