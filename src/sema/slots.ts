/**
 * SlotAllocator (docs/compiler-design.md §5) — assigns stable compile-time ids:
 *   - history slots:  values referenced with `[]` (dense, start after builtin slots)
 *   - state slots:    stateful builtin call sites (ta.*, fixnan)
 *   - var slots:      var/varip persistence
 *
 * Ids are dense and monotonic so the runtime indexes arrays, not maps, on the
 * hot path. Builtin OHLCV+time slots 0..5 are reserved (see BuiltinSlot).
 */
import { BuiltinSlot } from '../runtime/context.js';

export class SlotAllocator {
  private nextHistory = BuiltinSlot.Count;
  private nextState = 0;
  private nextVar = 0;

  historySlot(): number {
    return this.nextHistory++;
  }
  stateSlot(): number {
    return this.nextState++;
  }
  varSlot(): number {
    return this.nextVar++;
  }

  get counts() {
    return {
      historySlotCount: this.nextHistory, // includes the 6 builtin slots
      stateSiteCount: this.nextState,
      varSlotCount: this.nextVar,
    };
  }
}
