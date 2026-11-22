// Launch Radar model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The idea in one paragraph. Protocols whose token already trades reveal what the market pays for a
// dollar of TVL in their line of business: their market-cap / TVL multiple. A protocol that records
// no token yet gets the multiple its trading peers earn, shrunk toward the wider market when its own
// category or chain offers only a few peers, then adjusted for what its own record shows — seven-day
// TVL growth (a launch into momentum is worth more) and age (a protocol that has run for years with
// no token has had time to become worth launching). Nothing is looked up by name: every figure below
// is computed from the snapshot's ten fields, and the same code prices every row.
//
//   implied = TVL x peerMultiple(category, chain) x growthFactor(change_7d) x maturityFactor(age)
//
// The board ranks every pre-token protocol that is a candidate for a launch of its own: the whole
// watchlist, plus everything below the watchlist's floor that passes the same product rules.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it, so a reader can tell one model from another. */
export const MODEL_VERSION = 'peer-multiple-2';

/** Peer multiples are clipped to this band before any median is taken, so one mispriced micro-cap
 *  (a $5M-TVL token with a $2B market cap) cannot set a whole category's price. */
const MULT_FLOOR = 0.01;
const MULT_CAP = 10;
/** How much evidence a category or chain median may contribute: its weight grows with its peer
 *  count and saturates, and a prior of the global median always steadies the blend. */
const EVIDENCE_SATURATION = 8;
const CHAIN_WEIGHT = 0.5;
const PRIOR_WEIGHT = 4;
/** Growth: change_7d is clamped, then each point of it moves the value by GROWTH_SLOPE. */
const GROWTH_CLAMP = { lo: -60, hi: 120 };
const GROWTH_SLOPE = 0.004;
/** Maturity: the factor runs from MATURITY_BASE for a brand-new protocol to +MATURITY_SPAN at
 *  MATURITY_FULL_DAYS of age; an unknown listing date is read as UNKNOWN_AGE_DAYS. */
const MATURITY_BASE = 0.82;
const MATURITY_SPAN = 0.28;
const MATURITY_FULL_DAYS = 1825;
const UNKNOWN_AGE_DAYS = 300;

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    peer_multiple: number;
    category_peers: number;
    growth_factor: number;
    maturity_factor: number;
  };
  farm_steps: string[];
}

/** One trading peer group's summary, for the dashboard's model panel. */
export interface PeerGroup {
  category: string;
  peers: number;
  median_multiple: number;
}

/** A protocol whose token already trades: shown apart, at the market's own figures, never ranked. */
export interface TradingRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

/** Everything the dashboard renders: the board, the peer evidence, the trading set, the counts. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  counts: { protocols: number; trading: number; board: number; watchlist: number; below_floor: number };
  global_multiple: number;
  peers: PeerGroup[];
  trading: TradingRow[];
  rows: BoardRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, the middle value once sorted. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** A trading protocol's market multiple, clipped to the model's band. */
function clippedMultiple(p: SnapshotProtocol): number {
  return Math.min(MULT_CAP, Math.max(MULT_FLOOR, p.mcap_usd! / p.tvl_usd));
}

/** Whether a protocol records a token: a CoinGecko id or a ticker is a token, priced or not. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are a wrapped, staked or bridged claim on a token that already trades, or an
 *  exchange's own venue: none of them is waiting on a launch of its own. The bridge categories are
 *  out in full: in this snapshot the category mixes bridge protocols with bridged representations
 *  of trading tokens (WBTC and USDT0 sit in it), and the ten fields cannot tell the two apart, so
 *  the house's line — no bridges — is the only defensible one. The set is the watchlist's own six
 *  product categories, so every watchlist slug passes it by construction. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Exchange names a product may begin with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol is a product of another token rather than a launch candidate of its own. */
export function isProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e));
}

/** Whether the board may rank a protocol: it records no token and is not another token's product. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return !recordsToken(p) && !isProduct(p);
}

/** The peer evidence: trading multiples grouped by category and by chain, plus the global median. */
export interface PeerEvidence {
  global: number;
  byCategory: Map<string, { median: number; n: number }>;
  byChain: Map<string, { median: number; n: number }>;
  groups: PeerGroup[];
}

/** Build the peer evidence from every protocol whose token trades with a recorded market cap. */
export function peerEvidence(snapshot: Snapshot): PeerEvidence {
  const peers = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const catValues = new Map<string, number[]>();
  const chainValues = new Map<string, number[]>();
  for (const p of peers) {
    const m = clippedMultiple(p);
    if (p.category !== null) {
      const list = catValues.get(p.category) ?? [];
      list.push(m);
      catValues.set(p.category, list);
    }
    for (const chain of p.chains) {
      const list = chainValues.get(chain) ?? [];
      list.push(m);
      chainValues.set(chain, list);
    }
  }
  const summarise = (map: Map<string, number[]>): Map<string, { median: number; n: number }> =>
    new Map([...map.entries()].map(([k, v]) => [k, { median: median(v), n: v.length }]));
  const byCategory = summarise(catValues);
  const groups = [...byCategory.entries()]
    .map(([category, v]) => ({ category, peers: v.n, median_multiple: round4(v.median) }))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  return { global: median(peers.map(clippedMultiple)), byCategory, byChain: summarise(chainValues), groups };
}

/**
 * The multiple one protocol is priced at: its category's peer median and its main chain's peer
 * median, each weighted by how much evidence backs it, shrunk toward the global median. A category
 * with one wild peer moves the price a little; a category with thirty peers moves it a lot.
 */
export function peerMultiple(p: SnapshotProtocol, ev: PeerEvidence): { multiple: number; categoryPeers: number } {
  let num = ev.global * PRIOR_WEIGHT;
  let den = PRIOR_WEIGHT;
  const cat = p.category !== null ? ev.byCategory.get(p.category) : undefined;
  if (cat !== undefined) {
    const w = Math.min(cat.n, EVIDENCE_SATURATION);
    num += cat.median * w;
    den += w;
  }
  const mainChain = p.chains[0];
  const chain = mainChain !== undefined ? ev.byChain.get(mainChain) : undefined;
  if (chain !== undefined) {
    const w = Math.min(chain.n, EVIDENCE_SATURATION) * CHAIN_WEIGHT;
    num += chain.median * w;
    den += w;
  }
  return { multiple: num / den, categoryPeers: cat?.n ?? 0 };
}

/** The growth factor: seven-day TVL momentum, clamped so one wild week cannot double a value. */
export function growthFactor(change7d: number | null): number {
  const g = Math.min(GROWTH_CLAMP.hi, Math.max(GROWTH_CLAMP.lo, change7d ?? 0));
  return 1 + g * GROWTH_SLOPE;
}

/** The maturity factor: the longer a protocol has run tokenless, the closer to a launch it reads. */
export function maturityFactor(age: number | null): number {
  const days = Math.min(age ?? UNKNOWN_AGE_DAYS, MATURITY_FULL_DAYS);
  return MATURITY_BASE + (days / MATURITY_FULL_DAYS) * MATURITY_SPAN;
}

/** One protocol's implied launch value and the factors that produced it. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  ev: PeerEvidence,
): { implied: number; multiple: number; categoryPeers: number; growth: number; maturity: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, categoryPeers } = peerMultiple(p, ev);
  const growth = growthFactor(p.change_7d);
  const maturity = maturityFactor(age);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth * maturity));
  return { implied, multiple, categoryPeers, growth, maturity, age };
}

// ------------------------------------------------------------------ farm plans
//
// A farm plan is assembled from the protocol's own record: its category chooses the core action, its
// main chain the gas a transaction costs there, its TVL the size of position worth holding, and its
// age how long the position should run. A small hash of the slug picks among phrasings, so two
// protocols in the same category at the same size still read differently, and the plan is stable
// across runs because the hash is.

/** Roughly what one simple transaction costs on a chain, in dollars, as the plans state it. */
const GAS_USD: Record<string, number> = {
  Ethereum: 7.5, Binance: 0.3, Solana: 0.04, Base: 0.08, Arbitrum: 0.25, Optimism: 0.2,
  Polygon: 0.02, Avalanche: 0.35, Tron: 1.2, Bitcoin: 1.5, Mantle: 0.05, Linea: 0.15,
  Scroll: 0.1, zkSync: 0.1, Starknet: 0.15, Fantom: 0.05, xDai: 0.01, Sei: 0.02, Sui: 0.03, Aptos: 0.03,
};

/** A stable small hash of a slug, for choosing phrasings. */
function hashOf(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Dollars with thousands separators, as the plans and the page write them. */
export function usd(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** A gas figure as a short phrase: cents under a dime, two decimals under ten dollars. */
function gasText(gas: number): string {
  if (gas < 0.1) return `${Math.max(1, Math.round(gas * 100))} cents`;
  if (gas < 10) return `$${gas.toFixed(2)}`;
  return usd(gas);
}

/** The position size worth holding, from the protocol's TVL: bigger protocols reward bigger farms. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 250_000_000) return 250;
  if (tvl >= 50_000_000) return 150;
  if (tvl >= 15_000_000) return 100;
  return 60;
}

/** How many weeks a position should run, from the protocol's age: younger ones qualify slower. */
function holdWeeksFor(age: number | null): number {
  if (age === null) return 8;
  if (age < 180) return 10;
  if (age < 540) return 8;
  return 6;
}

/** The core farming action for a category, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${usd(capital)} of USDC to ${n} on ${chain}, then borrow about a third of it back and re-supply the loan, so both sides of the market count your wallet`;
  if (c.includes('dex')) return `Provide ${usd(capital)} of liquidity to ${n}'s busiest USDC pair on ${chain} and leave the LP position untouched between weekly checks`;
  if (c.includes('bridge')) return `Bridge ${usd(capital)} of USDC to ${chain} through ${n}, then bridge a smaller sum back a week later, so both directions sit in its transfer history`;
  if (c.includes('derivat') || c.includes('perpetual')) return `Deposit ${usd(capital)} of USDC as margin on ${n} and hold one small hedged perpetual position, rolling it weekly instead of trading actively`;
  if (c.includes('option')) return `Deposit ${usd(capital)} into ${n}'s flagship options vault on ${chain} and let the weekly epoch roll your premium share`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit ${usd(capital)} into a ${n} curated vault on ${chain} and keep the vault shares in the same wallet for the whole run`;
  if (c.includes('rwa')) return `Subscribe ${usd(capital)} to ${n}'s tokenised asset on ${chain} and hold the issued shares rather than redeeming early`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${usd(capital)} of the chain's asset through ${n} on ${chain} and keep the staking receipt in the wallet untouched`;
  if (c.includes('prediction')) return `Fund ${usd(capital)} on ${n} and hold positions in three liquid markets at once, settling each before it closes`;
  if (c.includes('launchpad')) return `Register the wallet with ${n} and complete its participation tasks, then commit ${usd(capital)} to the next sale it opens`;
  if (c.includes('privacy')) return `Deposit ${usd(capital)} into ${n}'s shielded pool on ${chain} and make one private transfer a week from inside it`;
  if (c.includes('basis')) return `Deposit ${usd(capital)} of USDC into ${n}'s basis vault on ${chain} and hold through a full funding cycle`;
  if (c.includes('stable') || c.includes('algo')) return `Mint ${usd(capital)} of ${n}'s stable asset on ${chain} and provide it to the deepest pool that pairs it with USDC`;
  if (c.includes('insurance')) return `Buy ${usd(capital)} of protocol cover from ${n} on ${chain} and keep the policy active for the full term`;
  if (c.includes('chain')) return `Bridge ${usd(capital)} to ${chain} and use two of its native applications through ${n}'s ecosystem, keeping a working balance there`;
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Deposit ${usd(capital)} into ${n}'s flagship vault on ${chain} and compound the yield back in once a week`;
  return `Deposit ${usd(capital)} of USDC into ${n}'s main product on ${chain} and keep the position open and untouched between checks`;
}

/** The weekly qualifying action for a category: the small repeat visit that keeps a farm alive. */
function weeklyAction(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `adjust the borrow on ${n} slightly — repay a slice or draw a little more — so the week shows a live lending position, not a parked one`;
  if (c.includes('dex') || c.includes('liquidity')) return `route one small swap through ${n} and re-check the LP range, topping the position up if it drifted out`;
  if (c.includes('bridge')) return `bridge a small sum — ${usd(25)} is enough — across ${n} in whichever direction you did not use last week`;
  if (c.includes('derivat')) return `roll the hedge on ${n} once and pay the week's funding, keeping the position small and delta-neutral`;
  if (c.includes('prediction')) return `settle one finished market on ${n} and place the proceeds into a fresh one the same visit`;
  if (c.includes('staking') || c.includes('restak') || c.includes('yield') || c.includes('curator') || c.includes('allocator')) return `claim and re-stake whatever ${n} paid out, so the week's rewards compound inside the same position`;
  return `make one small deposit or withdrawal of about ${usd(20)} on ${n}, so the week records a genuine transaction rather than a balance check`;
}

const SETUP_VARIANTS = [
  (chain: string, capital: number) => `Start with a fresh wallet funded only from your main wallet, holding the ${usd(capital)} farm capital plus ${chain} gas money, and save its address in a farm log`,
  (chain: string, capital: number) => `Create a dedicated wallet for this farm, fund it with the ${usd(capital)} position capital and a ${chain} gas float, and write the wallet and start date in a farm log`,
  (chain: string, capital: number) => `Use a wallet you do not trade from, fund it on ${chain} with the ${usd(capital)} farm capital plus gas, and record the funding transaction in a farm log`,
];
const EXIT_VARIANTS = [
  (n: string) => `Before any claim, check ${n}'s own announcements for a snapshot or claim date and only ever follow a claim link the protocol itself publishes`,
  (n: string) => `Watch ${n}'s official channels for a snapshot announcement; if a claim opens, use only the link in that announcement and never a search result`,
  (n: string) => `When ${n} announces anything about a token, verify it in two of its official channels before acting, and never pay a fee to claim`,
];

/** One farm step as a single string: the action, then what it costs and how long it takes. */
function step(text: string, cost: string, time: string): string {
  let s = `${text}. Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  return s;
}

/**
 * A protocol's farm plan: six steps assembled from its own record — category, main chain, TVL and
 * age — with the costs and times those imply. No step is written for a protocol by name.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const h = hashOf(p.slug);
  const chain = p.chains[0] ?? 'its main chain';
  const gas = GAS_USD[chain] ?? 0.5;
  const capital = capitalFor(p.tvl_usd);
  const weeks = holdWeeksFor(age);
  const weeklyMinutes = 8 + (h % 3) * 4;
  const steps = [
    step(SETUP_VARIANTS[h % SETUP_VARIANTS.length]!(chain, capital), `about ${gasText(gas * 2)} of gas to fund and approve`, '10 minutes once'),
    step(coreAction(p, capital, chain), `${usd(capital)} of capital plus about ${gasText(gas * 3)} of gas across the opening transactions`, '20 minutes to set up'),
    step(`Each week, ${weeklyAction(p)}`, `about ${gasText(gas)} of gas a week`, `${weeklyMinutes} minutes a week`),
  ];
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    steps.push(step(
      `In week two, extend the farm to ${second}: bridge ${usd(Math.round(capital / 2))} there and repeat the core action, since ${p.name} counts activity per chain`,
      `about $4 of bridge fees plus ${gasText(GAS_USD[second] ?? 0.5)} of gas`,
      '25 minutes once',
    ));
  } else {
    steps.push(step(
      `From week two, add ${p.name}'s governance to the routine: read its forum proposals and vote with the position wallet whenever a vote opens`,
      'no fee beyond a signature in most cases',
      '10 minutes when a vote is open',
    ));
  }
  steps.push(step(
    `Hold the position for at least ${weeks} weeks, checking the balance and the protocol's points or rewards page every Sunday, so the activity spans several weekly snapshots`,
    `the ${usd(capital)} stays in the position for the whole run`,
    `${weeks} weeks`,
  ));
  steps.push(step(EXIT_VARIANTS[h % EXIT_VARIANTS.length]!(p.name), 'nothing to check; never pay to claim', '10 minutes when news lands'));
  return steps;
}

// ------------------------------------------------------------------ the board

/** The protocols the board ranks, strongest first, with ranks 1..n and a farm plan each. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const ev = peerEvidence(snapshot);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter(isLaunchCandidate);
  const scored = chosen.map((p) => ({ p, ...impliedValue(p, snapshot.as_of, ev) }));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    token_status: 'pre-token' as const,
    watchlist: watch.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      peer_multiple: round4(s.multiple),
      category_peers: s.categoryPeers,
      growth_factor: round4(s.growth),
      maturity_factor: round4(s.maturity),
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

/** The trading set apart: the protocols whose token already trades, by market cap, top 24. */
export function tradingRows(snapshot: Snapshot): TradingRow[] {
  return snapshot.protocols
    .filter((p) => recordsToken(p) && p.mcap_usd !== null && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: round4(p.mcap_usd! / p.tvl_usd),
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const ev = peerEvidence(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    counts: {
      protocols: snapshot.protocols.length,
      trading: snapshot.protocols.filter(recordsToken).length,
      board: board.length,
      watchlist: snapshot.watchlist.length,
      below_floor: board.filter((r) => r.tvl_usd < snapshot.floor_usd).length,
    },
    global_multiple: round4(ev.global),
    peers: ev.groups,
    trading: tradingRows(snapshot),
    rows: board,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
