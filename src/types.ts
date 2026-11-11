/**
 * Core type model and constants shared across the game.
 *
 * Keeping every type in one place means the reducers in `state.ts` and the
 * renderer in `view.ts` agree on the shape of the world without importing
 * each other, so state processing stays independent of how it is drawn.
 */

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Target = {
    WIDTH: 64,
    HEIGHT: 36,
} as const;

const Constants = {
    DIGIT_COUNT: 8,
    /** Length of one time step, roughly sixty steps a second. */
    TICK_RATE_MS: 16,
    /** Height the bottom of a target must reach to be judged. */
    CHECK_LINE_Y: 340,
    /** Distance a target descends each tick. */
    FALL_SPEED: 0.75,
    /** Shortest wait before the next target. One second at 16 ms a tick. */
    SPAWN_MIN_TICKS: 63,
    /** Longest wait before the next target. Three seconds at 16 ms a tick. */
    SPAWN_MAX_TICKS: 188,
    /** Largest value a target can take, matching an eight digit binary row. */
    MAX_TARGET_VALUE: 255,
    /** Ticks of survival that add one further `FALL_SPEED` to the descent. */
    SPEEDUP_INTERVAL_TICKS: 1200,
    /** Ceiling on the descent, so the game stays playable once ramped up. */
    MAX_FALL_SPEED: 1.875,
} as const;

/**
 * The id carried by the digit box at `index`.
 *
 * The view stamps it onto the element and the click stream reads it back, so
 * a click can be traced to a digit without either module importing the other.
 *
 * @param index Position of the digit in the row, counting from the left
 * @returns Id for that digit's box
 */
const digitElementId = (index: number): string => `digit-${index}`;

/**
 * One binary digit of the player's answer.
 *
 * A union of the only two legal values rather than `number`, so an out of
 * range digit is a compile error instead of a rendering bug.
 */
type Bit = 0 | 1;

/** The player's current answer, most significant bit first. */
type BitRow = readonly Bit[];

/**
 * A hexadecimal number falling toward the check line.
 *
 * Targets carry no horizontal position because they all fall down the centre
 * of the canvas; `id` exists so the renderer can match a target to the SVG
 * element it already created for it.
 */
type FallingNumber = Readonly<{
    id: string;
    value: number;
    y: number;
}>;

/**
 * The whole world at one instant.
 *
 * `exit` holds targets that left play on the most recent tick. The renderer
 * consumes it to delete the matching SVG elements, which keeps removal a
 * consequence of state rather than something the reducers reach out and do.
 */
type State = Readonly<{
    bits: BitRow;
    targets: readonly FallingNumber[];
    exit: readonly FallingNumber[];
    score: number;
    /** Highest score reached so far, carried across restarts. */
    best: number;
    gameEnd: boolean;
    ticksUntilSpawn: number;
    spawnCount: number;
    elapsed: number;
    seed: number;
    paused: boolean;
}>;

/**
 * A single state transition.
 *
 * Every event the game reacts to becomes an `Action`, so the main stream can
 * merge unrelated sources and fold them all with one `scan`.
 */
interface Action {
    apply(s: State): State;
}

/** All digits off, nothing on screen, nothing scored yet. */
const initialState: State = {
    bits: Array.from({ length: Constants.DIGIT_COUNT }, (): Bit => 0),
    targets: [],
    exit: [],
    score: 0,
    best: 0,
    gameEnd: false,
    ticksUntilSpawn: 0,
    spawnCount: 0,
    elapsed: 0,
    seed: 1,
    paused: false,
};

export { Viewport, Target, Constants, digitElementId, initialState };
export type { Bit, BitRow, FallingNumber, State, Action };
