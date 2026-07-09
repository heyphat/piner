/**
 * Piner — clean-room Pine Script v6 engine.
 *
 * Public API. The full pipeline (Pine source → ScriptFn) works for the
 * implemented v6 subset (docs/compiler-design.md §8); the runtime core and
 * driver also run hand-written `ScriptFn` bodies.
 */

// Compiler pipeline
export { compile, compileAsync, CompileError } from './engine/compiler.js';
export type { CompiledScript, ScriptMetadata, CompileAsyncOptions } from './engine/compiler.js';
export { resolveLibraryClosure } from './sema/resolve.js';
export type { AsyncLibrarySource, ResolveClosureOptions } from './sema/resolve.js';
export type {
  CompileOptions,
  LibraryRegistry,
  LibraryRegistryKey,
  LibraryIdentity,
  LibraryIdentityObject,
} from './sema/library.js';
export { tokenize, LexError } from './lexer/lexer.js';
export { parse, ParseError } from './parser/parser.js';
export { analyze } from './sema/analyze.js';
export type { Diagnostic, AnalyzeResult, InputDecl, SecurityDependency } from './sema/analyze.js';
export { emit } from './codegen/emit.js';
export { makeInterpreted } from './interp/interpreter.js';
export type * as ast from './parser/ast.js';

// Engine & execution
export { Engine } from './engine/engine.js';
export type { RunOptions, EngineOptions } from './engine/engine.js';
export { Driver } from './engine/driver.js';
export type { ScriptFn } from './engine/driver.js';
export { ArrayFeed } from './engine/feed.js';
export type { DataFeed, Bar, TickHandler } from './engine/feed.js';

// Runtime
export {
  ExecutionContext,
  BuiltinSlot,
  NA,
  isNa,
  DEFAULT_LOOP_ITERATION_BUDGET,
  ExecutionBudgetError,
} from './runtime/context.js';
export type { RollbackSnapshot } from './runtime/context.js';
export { SeriesStore } from './runtime/series.js';
export { Ta } from './runtime/builtins/ta.js';
export { ArrayNs } from './runtime/builtins/array.js';
export { MapNs } from './runtime/builtins/map.js';
export { MatrixNs } from './runtime/builtins/matrix.js';
export type { Matrix } from './runtime/builtins/matrix.js';
export { DrawingPool } from './runtime/builtins/drawing.js';
export type { DrawObject, DrawType } from './runtime/builtins/drawing.js';
export { OutputCollector } from './runtime/output.js';
export type {
  PlotSeries,
  MarkerSeries,
  MarkerPoint,
  CandleSeries,
  OHLC,
  HLine,
  FillRegion,
  FillGradient,
  AlertEvent,
  SecurityRequest,
} from './runtime/output.js';
export type { BarState } from './runtime/barstate.js';
export { StrategyBroker, Account } from './runtime/builtins/strategy.js';
export { PortfolioEngine } from './engine/portfolio-engine.js';
export type {
  PortfolioEngineOptions,
  PortfolioSleeveSpec,
  PortfolioSleeveResult,
  PortfolioReport,
} from './engine/portfolio-engine.js';
export type { StrategySettings, ClosedTrade, StrategyReport } from './runtime/builtins/strategy.js';
export { computeStrategyMetrics } from './engine/strategy-metrics.js';
export type { StrategyMetrics, StrategyMetricsOptions } from './engine/strategy-metrics.js';

// Semantics (types)
export { Qualifier } from './sema/types.js';
export type { PineType, QualifiedType } from './sema/types.js';
