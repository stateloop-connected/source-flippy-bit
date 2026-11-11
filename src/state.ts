/**
 * Pure state processing.
 *
 * Nothing in this file touches the DOM or reads the clock, so every function
 * here can be exercised directly from a test by handing it a state and
 * comparing the state it returns.
 */

import { Constants, Target, Viewport, initialState } from "./types.ts";
import type { Action, Bit, BitRow, FallingNumber, State } from "./types.ts";
import { nextSeed, pipeline, toRange, unitInterval } from "./util.ts";

/** The opposite of a bit. */
const flip = (bit: Bit): Bit => (bit === 0 ? 1 : 0);

/**
 * The number the digit row currently represents.
 *
 * @param bits Digit row, most significant bit first
 * @returns Value of the row read as a binary number
 */
const bitsToValue = (bits: BitRow): number =>
    bits.reduce<number>((value, bit) => value * 2 + bit, 0);

/**
 * The target nearest the check line, or undefined when none are in play.
 *
 * Lowest means largest `y`, since the canvas measures downwards. This is
 * found rather than assumed from the order targets were added, so it stays
 * correct if targets ever move at different speeds.
 *
 * @param targets Targets currently on screen
 * @returns The lowest of them
 */
const lowestTarget = (
    targets: readonly FallingNumber[],
): FallingNumber | undefined =>
    targets.reduce<FallingNumber | undefined>(
        (lowest, target) =>
            lowest === undefined || target.y > lowest.y ? target : lowest,
        undefined,
    );

/** Whether a target has descended far enough to be judged. */
const atCheckLine = (target: FallingNumber): boolean =>
    target.y + Target.HEIGHT >= Constants.CHECK_LINE_Y;

/**
 * The target the sequence produces for a given spawn number.
 *
 * The count doubles as the identifier, which saves generating one and keeps
 * ids stable for the renderer to match elements against.
 *
 * @param spawnCount How many targets have appeared so far
 * @param seed Seed drawn for this target's value
 * @returns A target starting just above the top of the canvas
 */
const nextTarget = (spawnCount: number, seed: number): FallingNumber => ({
    id: `target-${spawnCount}`,
    value: toRange(unitInterval(seed), 0, Constants.MAX_TARGET_VALUE),
    y: -Target.HEIGHT,
});

/**
 * Releases a target and schedules the one after it.
 *
 * Two draws are taken: the first fixes this target's value, the second the
 * wait before the next appears. The second seed is kept in the state so the
 * following spawn carries on from where this one stopped, which is what makes
 * the whole run reproducible from its opening seed.
 *
 * @param s Current state
 * @returns State with the new target and the next wait set
 */
const releaseTarget = (s: State): State => {
    const valueSeed = nextSeed(s.seed);
    const waitSeed = nextSeed(valueSeed);
    return {
        ...s,
        targets: [...s.targets, nextTarget(s.spawnCount, valueSeed)],
        spawnCount: s.spawnCount + 1,
        ticksUntilSpawn: toRange(
            unitInterval(waitSeed),
            Constants.SPAWN_MIN_TICKS,
            Constants.SPAWN_MAX_TICKS,
        ),
        seed: waitSeed,
    };
};

/** Empties the previous tick's departures so `exit` only holds fresh ones. */
const clearExit = (s: State): State => ({ ...s, exit: [] });

/**
 * How far targets descend per tick after surviving `elapsed` ticks.
 *
 * The descent grows steadily with time served and then holds at a ceiling,
 * because an uncapped ramp eventually outruns any reaction time and the game
 * stops being winnable rather than becoming hard.
 *
 * @param elapsed Ticks survived so far
 * @returns Distance to descend this tick
 */
const fallSpeed = (elapsed: number): number =>
    Math.min(
        Constants.FALL_SPEED * (1 + elapsed / Constants.SPEEDUP_INTERVAL_TICKS),
        Constants.MAX_FALL_SPEED,
    );

/** Counts the tick currently being processed. */
/**
 * How many times faster than the opening pace targets are falling.
 *
 * Shown to the player so the ramp-up is visible rather than only felt.
 *
 * @param elapsed Ticks survived so far
 * @returns Multiplier from 1 up to the ceiling set by `MAX_FALL_SPEED`
 */
const speedMultiplier = (elapsed: number): number =>
    fallSpeed(elapsed) / Constants.FALL_SPEED;

/** Whether the descent has reached its ceiling. */
const atTopSpeed = (elapsed: number): boolean =>
    fallSpeed(elapsed) >= Constants.MAX_FALL_SPEED;

const advanceClock = (s: State): State => ({ ...s, elapsed: s.elapsed + 1 });

/** Moves every target one step closer to the check line. */
const fall = (s: State): State => ({
    ...s,
    targets: s.targets.map(target => ({
        ...target,
        y: target.y + fallSpeed(s.elapsed),
    })),
});

/**
 * Retires targets that have dropped out of the play area.
 *
 * They are collected into `exit` rather than simply dropped, because the
 * renderer has no other way of knowing which SVG elements to delete.
 */
const despawn = (s: State): State => {
    const gone = (target: FallingNumber): boolean =>
        target.y > Viewport.CANVAS_HEIGHT;
    return {
        ...s,
        targets: s.targets.filter(target => !gone(target)),
        exit: s.targets.filter(gone),
    };
};

/** Releases the next target once the spawn timer runs out. */
const spawn = (s: State): State =>
    s.ticksUntilSpawn > 0
        ? { ...s, ticksUntilSpawn: s.ticksUntilSpawn - 1 }
        : releaseTarget(s);

/**
 * Whether a target has descended far enough to be read and played against.
 *
 * Targets start above the top edge, and matching one while it is still out of
 * sight would award a point for something the player never saw.
 */
const inPlay = (target: FallingNumber): boolean => target.y >= 0;

/**
 * Retires a target the player has matched, and scores it.
 *
 * @param s Current state
 * @param target Target that has been matched
 * @returns Updated state
 */
const resolve = (s: State, target: FallingNumber): State => ({
    ...s,
    targets: s.targets.filter(other => other.id !== target.id),
    exit: [...s.exit, target],
    score: s.score + 1,
    best: Math.max(s.best, s.score + 1),
});

/**
 * Deals with a target the row does not currently match.
 *
 * Nothing happens while it still has room to fall; the check line is the
 * deadline, and arriving at it unmatched is what ends the game. The target is
 * left on screen so the player can read the value that beat them.
 *
 * @param s Current state
 * @param target Lowest target, which the row does not match
 * @returns Updated state
 */
const missed = (s: State, target: FallingNumber): State =>
    atCheckLine(target) ? { ...s, gameEnd: true } : s;

/**
 * Settles the lowest target against the digit row.
 *
 * A match retires the target wherever it has fallen to, so the player has the
 * whole descent to arrive at the value rather than one instant at the line.
 * A target that does reach the line has therefore gone unmatched all the way
 * down, which is exactly the moment the game should end.
 *
 * @param s Current state
 * @param target Target being judged
 * @returns Updated state
 */
const settle = (s: State, target: FallingNumber): State =>
    bitsToValue(s.bits) === target.value
        ? resolve(s, target)
        : missed(s, target);

/**
 * Judges the lowest target in play, on every step of the clock.
 *
 * Only the lowest is ever compared, so targets above it are ignored until the
 * one below them has been resolved or has ended the game.
 */
const judge = (s: State): State => {
    const lowest = lowestTarget(s.targets);
    return lowest !== undefined && inPlay(lowest) ? settle(s, lowest) : s;
};

/** Everything one time step does, in the order it happens. */
const step: (s: State) => State = pipeline(
    clearExit,
    advanceClock,
    fall,
    despawn,
    spawn,
    judge,
);

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State): State => (s.gameEnd || s.paused ? s : step(s));

/** Advances the game by one time step. */
class Tick implements Action {
    apply(s: State): State {
        return tick(s);
    }
}

/**
 * Flips one digit of the player's answer, counting from the left.
 *
 * The row is rebuilt with `map` rather than written into, so the state handed
 * in survives unchanged and a test can compare it against the result.
 */
class FlipDigit implements Action {
    constructor(public readonly index: number) {}

    apply(s: State): State {
        return s.gameEnd || s.paused
            ? s
            : {
                  ...s,
                  bits: s.bits.map((bit, i) =>
                      i === this.index ? flip(bit) : bit,
                  ),
              };
    }
}

/**
 * Halts and resumes play.
 *
 * Pausing freezes the clock, and `FlipDigit` refuses to act while it holds, so
 * the pause cannot be used to buy thinking time on the target in front of you.
 * A finished game is already stopped, so pausing one does nothing.
 */
class TogglePause implements Action {
    apply(s: State): State {
        return s.gameEnd ? s : { ...s, paused: !s.paused };
    }
}

/**
 * Returns the game to its opening position, from play or from game over.
 *
 * The targets still in play are handed to `exit` rather than dropped, because
 * that list is how the renderer learns which elements to delete. Resetting to
 * `initialState` alone would strand them on the canvas forever. The best score
 * survives the restart; that is the point of keeping it.
 */
class Restart implements Action {
    apply(s: State): State {
        return { ...initialState, exit: s.targets, seed: s.seed, best: s.best };
    }
}

/**
 * Folds a single action into the state.
 *
 * Every stream in `observable.ts` emits an Action, so merging those streams
 * and folding them with this one function is all the state management the
 * game needs.
 *
 * @param s Current state
 * @param action Action to apply
 * @returns Updated state
 */
const reduceState = (s: State, action: Action): State => action.apply(s);

export {
    flip,
    bitsToValue,
    lowestTarget,
    atCheckLine,
    inPlay,
    nextTarget,
    releaseTarget,
    fallSpeed,
    speedMultiplier,
    atTopSpeed,
    clearExit,
    advanceClock,
    fall,
    despawn,
    spawn,
    resolve,
    missed,
    settle,
    judge,
    step,
    tick,
    reduceState,
    Tick,
    FlipDigit,
    Restart,
    TogglePause,
};
