/**
 * Functions creating the Observable streams the game reacts to.
 *
 * Each stream turns raw browser events into Actions, so `main.ts` can merge
 * sources that have nothing else in common and fold them all with one scan.
 */

import { filter, fromEvent, interval, map, merge, take } from "rxjs";
import type { Observable } from "rxjs";

import { Constants, digitElementId } from "./types.ts";
import { Lehmer, nextSeed } from "./util.ts";
import type { Action } from "./types.ts";
import { FlipDigit, Restart, Tick, TogglePause } from "./state.ts";

/**
 * Key codes flipping each digit, ordered left to right.
 *
 * `KeyboardEvent.code` is matched rather than `key` so that the mapping does
 * not shift with the keyboard layout or when a modifier is held down.
 */
const digitKeyCodes: readonly string[] = Array.from(
    { length: Constants.DIGIT_COUNT },
    (_, index) => `Digit${index + 1}`,
);

/**
 * Turns taken to spread out seeds drawn moments apart.
 *
 * The generator is linear and so is the clock, so feeding one straight into
 * the other makes the first target a near straight line in launch time:
 * reloading a few seconds later would step the opening value along by two or
 * three. Turning the generator over a few times first lets the modulus break
 * that up.
 */
const SEED_WARMUP_TURNS = 3;

/**
 * An opening seed for the run, read from the clock.
 *
 * This is the single place randomness enters impurely, and it sits out here
 * with the other event sources rather than in `state.ts`. Every draw after it
 * is a pure function of this number, so pinning it replays a run exactly.
 *
 * @returns A seed inside the generator's range, never zero
 */
const startingSeed = (): number =>
    Array.from({ length: SEED_WARMUP_TURNS }).reduce<number>(
        seed => nextSeed(seed),
        (Date.now() % (Lehmer.MODULUS - 1)) + 1,
    );

/** Key that returns the game to its opening position. */
const RESTART_KEY_CODE = "KeyR";

/** Key that halts and resumes play. */
const PAUSE_KEY_CODE = "KeyP";

/** Element ids of the digit boxes, ordered left to right. */
const digitElementIds: readonly string[] = Array.from(
    { length: Constants.DIGIT_COUNT },
    (_, index) => digitElementId(index),
);

/** The id of whatever was clicked, or "" when it was not an element. */
const targetId = (target: EventTarget | null): string =>
    target instanceof Element ? target.id : "";

/**
 * Completes a flip stream, given a source of candidate digit positions.
 *
 * Both control schemes end the same way: work out which digit was addressed,
 * throw away anything that addressed none, and announce the flip. Sharing the
 * tail keeps that rule in one place no matter how many ways of pointing at a
 * digit the game grows.
 *
 * @param index$ Positions addressed, using -1 for none
 * @returns Stream of flips for the positions that existed
 */
const toFlips = (index$: Observable<number>): Observable<Action> =>
    index$.pipe(
        filter(index => index >= 0),
        map(index => new FlipDigit(index)),
    );

/** Determines the rate of time steps */
const tick$ = (): Observable<Action> =>
    interval(Constants.TICK_RATE_MS).pipe(map(() => new Tick()));

/**
 * Flips a digit when its number key is pressed.
 *
 * Auto-repeat is dropped so that holding a key down flips its digit once
 * instead of toggling it many times a second.
 */
const flipByKey$ = (): Observable<Action> =>
    toFlips(
        fromEvent<KeyboardEvent>(document, "keydown").pipe(
            filter(event => !event.repeat),
            map(event => digitKeyCodes.indexOf(event.code)),
        ),
    );

/**
 * Flips a digit when it is clicked.
 *
 * The box carries its own id, so the clicked element identifies the digit
 * and the stream never needs to know where the row is drawn.
 */
const flipByClick$ = (): Observable<Action> =>
    toFlips(
        fromEvent<PointerEvent>(document, "pointerdown").pipe(
            map(event => digitElementIds.indexOf(targetId(event.target))),
        ),
    );

/**
 * Restarts the game when R is pressed.
 *
 * This is a plain Action rather than a fresh subscription because the start-up
 * code in `main.ts` takes only the first start signal, so `state$` is built once and a
 * restart has to travel through the same fold as everything else.
 */
const restart$ = (): Observable<Action> =>
    fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => !event.repeat && event.code === RESTART_KEY_CODE),
        map(() => new Restart()),
    );

/** Halts or resumes the game when P is pressed. */
const pause$ = (): Observable<Action> =>
    fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => !event.repeat && event.code === PAUSE_KEY_CODE),
        map(() => new TogglePause()),
    );

/** Where the best score is kept between visits. */
const BEST_SCORE_KEY = "flippy-bit:best";

/**
 * Reads a stored best score, rejecting anything that is not a whole number.
 *
 * Storage can hold anything a previous version or a curious user left there,
 * so the value is validated rather than trusted.
 *
 * @param raw Value read from storage, or null when nothing was stored
 * @returns A non-negative whole number, 0 when the input is unusable
 */
const parseBest = (raw: string | null): number => {
    const value = Number(raw);
    return raw !== null && Number.isInteger(value) && value > 0 ? value : 0;
};

/**
 * The best score from an earlier visit, or 0.
 *
 * Like the opening seed, this is an impure ingredient read once at start-up;
 * from then on the reducers carry the best score as ordinary state.
 */
const startingBest = (): number => {
    try {
        return typeof localStorage === "undefined"
            ? 0
            : parseBest(localStorage.getItem(BEST_SCORE_KEY));
    } catch {
        return 0;
    }
};

/**
 * Emits once, when the player first clicks, taps or presses Space.
 *
 * Nothing runs until then, so the opening screen waits for the player instead
 * of dropping targets on someone who has not started yet.
 */
const start$ = (): Observable<unknown> =>
    merge(
        fromEvent(document.body, "pointerdown"),
        fromEvent<KeyboardEvent>(document, "keydown").pipe(
            filter(event => event.code === "Space"),
        ),
    ).pipe(take(1));

export {
    BEST_SCORE_KEY,
    parseBest,
    startingBest,
    start$,
    startingSeed,
    toFlips,
    digitKeyCodes,
    digitElementIds,
    tick$,
    flipByKey$,
    flipByClick$,
    restart$,
    pause$,
};
