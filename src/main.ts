/**
 * Entry point: wires the event streams to the state fold and the renderer.
 *
 * Every input becomes an Action, the Actions are merged into one stream, and a
 * single `scan` folds them into the game state. Rendering is the only
 * subscriber, so all side effects happen in one place.
 */

import "./style.css";

import { Observable, merge, scan, switchMap, tap } from "rxjs";

import { initialState } from "./types.ts";
import type { State } from "./types.ts";
import { reduceState } from "./state.ts";
import {
    flipByClick$,
    flipByKey$,
    pause$,
    restart$,
    start$,
    startingBest,
    startingSeed,
    tick$,
} from "./observable.ts";
import { hideStartScreen, render } from "./view.ts";

export const state$ = (): Observable<State> =>
    merge(tick$(), flipByKey$(), flipByClick$(), restart$(), pause$()).pipe(
        // The opening seed and the stored best score are the only impure
        // ingredients; everything the reducers do with them is deterministic.
        scan(reduceState, {
            ...initialState,
            seed: startingSeed(),
            best: startingBest(),
        }),
    );

if (typeof window !== "undefined") {
    start$()
        .pipe(tap(hideStartScreen), switchMap(() => state$()))
        .subscribe(render());
}
