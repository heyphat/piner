/**
 * DataFeed — OHLCV provider (docs/architecture.md §11).
 *
 * The engine is deterministic: all time comes from the feed, never from the
 * system clock. A feed supplies closed historical bars and (optionally) a
 * realtime tick subscription where each update carries the full developing bar
 * plus whether this tick closes it.
 */

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TickHandler = (bar: Bar, isClose: boolean) => void;

export interface DataFeed {
  history(symbol: string, timeframe: string): Promise<Bar[]>;
  subscribe?(symbol: string, timeframe: string, onTick: TickHandler): () => void;
}

/** In-memory feed for tests and replay. */
export class ArrayFeed implements DataFeed {
  constructor(private readonly bars: Bar[]) {}
  async history(): Promise<Bar[]> {
    return this.bars.slice();
  }
}
