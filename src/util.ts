/**
 * Small helpers that know nothing about the game's state or its rendering.
 */

/**
 * Combines transformations into a single one that applies them left to right.
 *
 * Nesting calls directly reads back to front, which hides the order the
 * stages actually run in. This is written generically because that ordering
 * problem is not specific to game state.
 *
 * @param steps Transformations to run, in the order given
 * @returns One transformation running all of them
 */
const pipeline =
    <T>(...steps: readonly ((value: T) => T)[]) =>
    (value: T): T =>
        steps.reduce((current, step) => step(current), value);

/**
 * Formats a value as the text shown on a falling target.
 *
 * Padding to two digits keeps the label a constant width, so a target does
 * not appear to jitter as its value changes between runs.
 *
 * @param value Number to format
 * @returns Hexadecimal text, two digits wide
 */
const toHex = (value: number): string =>
    value.toString(16).toUpperCase().padStart(2, "0");

/**
 * Parameters of the Lehmer generator standing in for `Math.random`.
 *
 * These are the published "minimal standard" pair. Their product stays inside
 * the range JavaScript represents exactly, so the sequence is reproducible
 * instead of drifting once rounding sets in.
 */
const Lehmer = {
    MULTIPLIER: 16807,
    MODULUS: 2147483647,
} as const;

/**
 * The next seed in a pseudo-random sequence.
 *
 * `Math.random` cannot be used here: it reads hidden state, so a reducer
 * calling it would return different results for the same input and could not
 * be tested. Passing the seed through the game state instead keeps every
 * draw a pure function of what came before.
 *
 * @param seed Current seed, between 1 and MODULUS - 1
 * @returns The next seed in the sequence
 */
const nextSeed = (seed: number): number =>
    (seed * Lehmer.MULTIPLIER) % Lehmer.MODULUS;

/**
 * A seed rescaled to the interval between zero and one.
 *
 * @param seed Seed to rescale
 * @returns Fraction of the way through the generator's range
 */
const unitInterval = (seed: number): number => seed / Lehmer.MODULUS;

/**
 * Places a fraction on the whole numbers from `low` to `high` inclusive.
 *
 * @param fraction Value between zero and one
 * @param low Smallest number that can be produced
 * @param high Largest number that can be produced
 * @returns A whole number in that range
 */
const toRange = (fraction: number, low: number, high: number): number =>
    low + Math.floor(fraction * (high - low + 1));

export { pipeline, toHex, Lehmer, nextSeed, unitInterval, toRange };
