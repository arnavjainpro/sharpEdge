// The Learn curriculum.
//
// Twelve lessons, chosen on one rule: every lesson explains either a number
// sharpEdge already computes for you or a criterion the Practice drill already
// grades you on. That is the whole point. A generic trading course is a
// commodity; a course that can show you YOUR concentration figure while
// explaining concentration is not.
//
// Content lives here as typed data rather than loose markdown files so the
// live-data hooks are type-checked alongside the prose they belong to, and so
// adding a lesson needs no new static route.

export interface Facts {
  equity: number | null;          // account equity from risk_prefs
  riskPct: number;                // max risk per trade, %
  positions: number;
  topSector: string | null;
  topSectorPct: number | null;
  beta: number | null;
  atrTicker: string | null;       // a holding we can quote ATR for
  atrPct: number | null;
  atrPrice: number | null;
  avgR: number | null;            // from graded practice drills
  avgProcess: number | null;
  drills: number;
}

export interface CheckOption { text: string; correct?: boolean; why: string }
export interface Check { q: string; options: CheckOption[] }

export interface Lesson {
  id: string;
  level: string;
  title: string;
  minutes: number;
  summary: string;
  body: string;
  check?: Check;
  /** Practice criterion this lesson explains, for the drill -> lesson nudge. */
  criterion?: string;
  /** A callout built from the reader's own data. Return null when unavailable. */
  live?: (f: Facts) => string | null;
}

const money = (n: number) => "$" + Math.round(n).toLocaleString();

export const LEVELS = ["Foundations", "Reading the chart", "Risk"] as const;

export const LESSONS: Lesson[] = [
  // ── Foundations ───────────────────────────────────────────────────────────
  {
    id: "what-moves-price",
    level: "Foundations",
    title: "What actually moves a price",
    minutes: 4,
    summary: "Price is not value. It is the last thing someone agreed to pay.",
    body: `
A stock price is not a measurement of what a company is worth. It is a record of
the most recent trade: one buyer and one seller who agreed, for a moment, on a
number. Everything else is inference.

That matters because it explains something beginners find maddening. A company
reports great earnings and the stock falls. Nothing is broken. The price already
reflected what people expected. If the report was good but not as good as the
crowd had already paid for, the people who bought in advance now want out, and
selling pressure moves the price down. **Price responds to surprise, not to
news.**

### The three things that actually move it

**Money flow.** More buying pressure than selling pressure at the current price
pushes it up until enough sellers appear. This is mechanical, not philosophical.

**Expectation changes.** A new fact changes what people think the future looks
like: an earnings surprise, a guidance cut, a rate decision, a lawsuit.

**Forced participants.** Funds rebalancing, index inclusion, margin calls,
options hedging. These traders are not expressing an opinion. They have to
transact, and their size moves price against them.

### What this means for you

You are not predicting a company. You are predicting the behaviour of the other
participants and where they will be forced or willing to transact. That is why
the rest of this course is about structure, volatility and risk rather than
about whether a business is good.

A good business at a bad price is a bad trade. The market has no obligation to
agree with you on any particular day, and your account is settled daily.
`.trim(),
    check: {
      q: "A company beats earnings expectations and the stock drops 6%. What is the most likely explanation?",
      options: [
        { text: "The market is irrational and it will correct tomorrow", why: "This is the comfortable answer and it is usually wrong. It also gives you no way to act." },
        { text: "The result was good, but weaker than what buyers had already paid for", correct: true, why: "Right. Price already contained an expectation. Beating a low bar and beating the actual bar are different things." },
        { text: "Earnings do not affect stock prices", why: "They do, but through the gap between the result and the expectation, not the raw number." },
      ],
    },
  },
  {
    id: "bid-ask-spread",
    level: "Foundations",
    title: "Bid, ask, and the cost of impatience",
    minutes: 4,
    summary: "There are always two prices. Which one you get depends on how patient you are.",
    body: `
There is no single price. There are two:

- **Bid** is the highest price someone is currently willing to pay.
- **Ask** is the lowest price someone is currently willing to sell at.

The gap between them is the **spread**, and it is a real cost you pay on every
round trip. Buy at the ask, sell at the bid, and you have lost the spread before
the price has moved at all.

### Market orders versus limit orders

A **market order** says "fill me now, at whatever the other side is offering."
You cross the spread and pay for the certainty. In a liquid stock that costs a
cent. In a thin one it can cost several percent, which is a loss you took
voluntarily.

A **limit order** says "fill me at this price or better, and I will wait." You
avoid paying the spread, and accept that you might not get filled at all.

Neither is correct in general. If you are stopping out of a losing position,
certainty is worth paying for. If you are entering a planned setup, patience is
usually worth more than immediacy.

### Liquidity is the thing underneath

Spread is a symptom. The cause is liquidity: how much size is resting near the
current price. A liquid stock absorbs your order without moving. An illiquid one
moves against you as you fill, which is called **slippage**, and it is worst
exactly when you most want out.

This is why sharpEdge only scans names above a market cap and volume floor. A
setup you cannot exit at a sane price is not a setup.
`.trim(),
    check: {
      q: "You need to exit a position immediately because your stop was hit. Which order type fits?",
      options: [
        { text: "Market order, accepting the spread", correct: true, why: "Right. When the priority is being out, certainty of fill beats saving a cent. A limit order that never fills leaves you in the trade you decided to leave." },
        { text: "Limit order at the midpoint, to avoid the spread", why: "It may never fill. You would be holding a position you already decided to exit in order to save a small cost." },
        { text: "It makes no difference", why: "It does. The difference is whether you are actually out." },
      ],
    },
  },
  {
    id: "risk-reward",
    level: "Foundations",
    title: "Risk and reward: the only math that matters",
    minutes: 5,
    summary: "You do not need to be right often. You need to be paid enough when you are.",
    body: `
Before entering anything, you should be able to state three numbers: where you
get in, where you are wrong, and where you take profit. Those give you the
**reward-to-risk ratio**, and it is the single most useful number in trading.

    Risk    = entry - stop
    Reward  = target - entry
    R:R     = reward / risk

If you buy at 100, stop at 95 and target 115, you are risking 5 to make 15. That
is 3R. The R is the unit: one R is exactly the amount you decided to lose.

### Why this beats "win rate"

Two traders:

- Alice wins 70% of the time, but each win pays 0.5R and each loss costs 1R.
  Per ten trades: seven wins x 0.5 = +3.5R, three losses = -3R. Net **+0.5R**.
- Bob wins 35% of the time at 3R per win. Per ten trades: 3.5 wins x 3 = +10.5R,
  6.5 losses = -6.5R. Net **+4R**.

Bob is wrong about twice as often and makes eight times as much. Win rate on its
own tells you nothing. Only the combination of win rate and payoff does.

### The practical rule

Decide your minimum R:R before you look at the chart, then let it reject trades
for you. sharpEdge defaults to 2R, which means you must be paid at least twice
what you are risking. A setup that only offers 1.2R is not a bad chart; it is
just not worth your money, and passing on it is a decision, not an absence of
one.

The Practice drill scores this directly. If your target does not clear your R:R
threshold, you lose points even if the trade goes on to win, because the plan
was underpriced regardless of what happened next.
`.trim(),
    criterion: "Reward vs risk",
    live: (f) => f.equity == null ? null :
      `Your risk settings say **${f.riskPct}% per trade** on ${money(f.equity)}, so one R is about **${money(f.equity * f.riskPct / 100)}**. At a 2R target, a winning trade is worth roughly ${money(f.equity * f.riskPct / 100 * 2)}.`,
    check: {
      q: "A setup offers 1.1R. Your rule is 2R minimum. The chart looks excellent. What do you do?",
      options: [
        { text: "Take it, because the chart quality makes up for the ratio", why: "This is how rules die. A rule you override when you feel strongly is not a rule, it is a suggestion you ignore under pressure." },
        { text: "Pass, and log it as a decision", correct: true, why: "Right. The setup is not bad, it is underpriced for the risk. Passing is a real answer and the drill scores it as one." },
        { text: "Take it with a wider target to force the ratio to 2R", why: "Moving the target to fit the rule is the rule fitting you. If price is unlikely to reach the new target, you have made the plan worse, not better." },
      ],
    },
  },
  {
    id: "process-vs-outcome",
    level: "Foundations",
    title: "Why good trades lose",
    minutes: 5,
    summary: "Judging a decision by its result is the fastest way to unlearn a good habit.",
    body: `
Here is the uncomfortable part. If you take a 2R setup that wins 40% of the
time, you are profitable, and you still lose six times out of ten. Those six
losses are not mistakes. They are the cost of doing business, and they are
already priced into the strategy.

The trap is called **outcome bias**: judging a decision by how it turned out
rather than by what you knew when you made it. It is dangerous in trading
specifically because the feedback is loud, immediate and financial.

Consider what outcome bias teaches you:

- You take a disciplined trade with a defined stop. It loses. Lesson learned:
  "that setup does not work." **Wrong.** One sample tells you nothing.
- You panic-buy something with no plan and no stop. It rips 20%. Lesson learned:
  "trust my gut." **Wrong, and expensive later.** You just got paid for a
  behaviour that will eventually take a very large loss, because nothing was
  bounding it.

The second one is worse. Losing money on a good decision costs you money. Making
money on a bad decision costs you the habit.

### How sharpEdge handles this

The Practice drill gives you two scores and deliberately never averages them:

- **Process** grades the plan on its own terms: did you define risk, was the
  reward worth it, was the stop somewhere sane, was the entry realistic. It is
  computed before anyone knows what happened next.
- **Outcome** replays your exact plan against what the market actually did.

A 100 process score with a -1R outcome is not a contradiction. It is the most
common result of good trading, and seeing it repeatedly is the point. If the two
were blended into one grade you could not tell a good decision from a lucky one,
which is exactly the confusion this feature exists to remove.
`.trim(),
    live: (f) => f.drills < 3 || f.avgProcess == null ? null :
      `Across your ${f.drills} drills so far, your average process score is **${Math.round(f.avgProcess)}/100**${f.avgR != null ? ` and your average outcome is **${f.avgR >= 0 ? "+" : ""}${f.avgR.toFixed(2)}R**` : ""}. Watch those two move independently.`,
    check: {
      q: "You follow your plan exactly and the trade stops out for a full -1R. How should you record it?",
      options: [
        { text: "As a mistake, and adjust the strategy", why: "One loss is not evidence. Changing a system after every loss guarantees you are always trading the thing that just stopped working." },
        { text: "As a correctly executed trade with a losing outcome", correct: true, why: "Right. The plan was sound and the result was one draw from a distribution. Both facts are true at once." },
        { text: "As bad luck, and size up next time to make it back", why: "This is revenge trading. Increasing size after a loss is the single most reliable way to turn a drawdown into a blowup." },
      ],
    },
  },

  // ── Reading the chart ─────────────────────────────────────────────────────
  {
    id: "candles",
    level: "Reading the chart",
    title: "What one candle tells you",
    minutes: 4,
    summary: "Four numbers per bar, and the distance between two of them is the argument.",
    body: `
Every candle encodes four numbers for its period: **open, high, low, close**.
The thick body spans open to close. The thin wicks reach out to the high and the
low. Green means the close was above the open, red means below.

That is the mechanics. The reading is more interesting.

### The body is agreement, the wick is rejection

A long body means one side controlled the whole period. Price opened, moved in
one direction and closed near the extreme. Little disagreement.

A **long lower wick** means sellers pushed price down during the period and
buyers pushed it all the way back before the close. That level was tested and
rejected. Buyers were willing to defend it. A long upper wick is the same story
inverted.

A **doji**, where open and close are nearly equal, means the period resolved
nothing. Both sides fought to a draw. On its own that is noise. At the end of an
extended run, it is worth noticing, because it is the first period in a while
where the winning side stopped winning.

### The honest caveat

Single candles are weak evidence. A hammer in the middle of a range means
nothing. The same hammer at a level price has already defended twice, on heavy
volume, is a different sentence in a different paragraph.

Candles are vocabulary. Structure, which is the next lesson, is grammar. Reading
patterns without structure is how people end up seeing a signal in every bar,
which is why the Practice drill deliberately makes "no trade" a scoring answer.
`.trim(),
    check: {
      q: "A candle has a small body near its top and a long lower wick. What happened during that period?",
      options: [
        { text: "Sellers pushed price down and buyers bought it back before the close", correct: true, why: "Right. The wick marks territory that was tested and rejected. Whether it matters depends entirely on where it happened." },
        { text: "Price rose steadily all period", why: "That would be a long body with almost no lower wick." },
        { text: "Nothing traded below the open", why: "The long lower wick is exactly the record of trading well below the open." },
      ],
    },
  },
  {
    id: "trend-structure",
    level: "Reading the chart",
    title: "Trend, support, and resistance",
    minutes: 5,
    summary: "A trend is a sequence of higher lows. A level matters because people remember it.",
    body: `
An uptrend is not "the line goes up." It is a specific, checkable structure:
**higher highs and higher lows**. Each pullback stops above the previous
pullback. That tells you buyers are getting more aggressive, stepping in earlier
each time.

The moment a pullback breaks below the prior low, that structure is gone. You do
not need an indicator to tell you. The trend is defined by the structure, so
when the structure breaks the trend is over by definition.

### Why levels work at all

Support and resistance are not magic prices. They are memory.

If a stock fell hard from 50, some people bought near the top and are now
underwater. When price returns to 50, those holders finally get out at break
even, and their selling is real supply. Meanwhile traders who watched the level
hold before will short it again. The level "works" because enough participants
remember it and act at the same place.

This is why a level that has been tested three times matters more than a line
you drew once, and why levels get weaker each time they are tested. Every test
consumes some of the orders sitting there.

### Using it

Levels give you the two prices in every plan. **Your invalidation goes beyond
structure, not at an arbitrary distance.** If you are long because a level held,
then price closing decisively below that level is the market telling you the
reason for the trade is gone. That is where the stop belongs. Where exactly is
the next lesson.
`.trim(),
    criterion: "Entry realism",
    check: {
      q: "A stock in a clean uptrend pulls back and closes below its previous swing low. What has changed?",
      options: [
        { text: "Nothing, pullbacks are normal in an uptrend", why: "Pullbacks are normal, but a pullback that takes out the prior low is not just a pullback. The structure that defined the trend is gone." },
        { text: "The higher-low structure is broken, so the uptrend is over by definition", correct: true, why: "Right. The trend was defined by that structure. This does not guarantee a decline, but the reason to be long has been removed." },
        { text: "It is a buying opportunity because the stock is cheaper", why: "Cheaper than yesterday is not the same as cheap. This reasoning has no invalidation point, which means no stop." },
      ],
    },
  },
  {
    id: "atr",
    level: "Reading the chart",
    title: "ATR: what normal movement means",
    minutes: 5,
    summary: "One number that tells you how much this stock moves on an ordinary day.",
    body: `
**Average True Range** answers one question: how far does this thing typically
travel in a period? True Range is the largest of the high minus the low, the
distance from the previous close up to the high, and the distance from the
previous close down to the low. That last pair is what makes it handle gaps
honestly. ATR is the average of that over 14 periods.

### Why it is the most practical number on the chart

A 2 dollar move means nothing on its own. On a 20 dollar stock it is enormous.
On a 900 dollar stock it is a rounding error. ATR converts every price into the
same unit: **how unusual is this move for this stock right now.**

That gives you three things:

**A stop that fits the stock.** A stop closer than roughly 1 ATR sits inside the
daily noise, so ordinary movement takes you out even when your read was right.
A stop wider than about 3 ATR is not really controlling the loss any more.

**Position size that equalises risk.** If your stop is 1.5 ATR away and ATR
differs across two stocks, the share counts should differ too, so both positions
risk the same money. That is the next level of this course.

**Context on the move you are looking at.** A stock up 1.2 ATR today is having a
genuinely unusual day. Up 0.2 ATR is Tuesday.

### Where you already see it

The Practice drill shows you ATR before you commit and scores your stop distance
in ATR units. That criterion is not aesthetic. It is the difference between a
stop that reflects the stock's behaviour and one that reflects your hope.
`.trim(),
    criterion: "Stop distance",
    live: (f) => f.atrTicker == null || f.atrPct == null || f.atrPrice == null ? null :
      `Right now **${f.atrTicker}** has an ATR of about **${f.atrPct.toFixed(1)}%**, roughly **$${(f.atrPrice * f.atrPct / 100).toFixed(2)}** a day at $${f.atrPrice.toFixed(2)}. A 1.5 ATR stop on it would sit about $${(f.atrPrice * f.atrPct / 100 * 1.5).toFixed(2)} from your entry.`,
    check: {
      q: "A stock has a daily ATR of $3. You set your stop $0.40 below entry. What is the likely result?",
      options: [
        { text: "Tight risk control, which is good", why: "It is tight, but it is not control. You are inside the noise, so you will be stopped out by ordinary movement regardless of whether the idea was right." },
        { text: "You get stopped out by normal daily movement even when the read is correct", correct: true, why: "Right. At 0.13 ATR your stop is well inside a typical day's range. You have guaranteed a loss on most correct calls." },
        { text: "Nothing, stop distance is a matter of preference", why: "It has a measurable consequence. Stop distance relative to volatility decides how often noise alone ends the trade." },
      ],
    },
  },
  {
    id: "volume",
    level: "Reading the chart",
    title: "Volume: confirmation, not prediction",
    minutes: 4,
    summary: "Volume cannot tell you direction. It can tell you whether to believe the move.",
    body: `
Volume is how many shares changed hands. It has no direction of its own, which
is why "high volume" is not bullish or bearish by itself. What it measures is
**participation**, and participation is what separates a move that means
something from a move that happened because nobody was around.

### The useful readings

**Breakout on heavy volume.** Price clears a level that has held before, and
volume is well above its recent average. Many participants are involved and the
level genuinely changed hands. More likely to hold.

**Breakout on light volume.** Same chart pattern, but almost nobody
participated. Often it drifts back inside the range within days. This is the
single most common false signal in retail trading, and volume is what
distinguishes it from the real thing.

**A climax.** An enormous volume spike after a long directional run frequently
marks exhaustion rather than continuation: the last buyers finally capitulating
in. It does not predict a reversal, but it does say the easy part is finished.

**Drying up in a range.** Falling volume while price consolidates means the
argument is running out of participants. Often precedes an expansion, though it
tells you nothing about which way.

### How to use it honestly

Volume is a filter, never a trigger. You do not buy because volume was high. You
decline to believe a breakout because volume was low. Used that way it removes
a whole category of bad trades without adding any new ones.

sharpEdge builds this in: its breakout and breakdown states carry a volume
confirmation flag, and unconfirmed ones are scored lower on purpose.
`.trim(),
    check: {
      q: "A stock breaks above a level it has failed at twice, on volume 30% below its 20-day average. What is the reasonable read?",
      options: [
        { text: "Strong breakout, buy it", why: "The pattern is there but the participation is not. This is the classic false breakout profile." },
        { text: "Treat it as unconfirmed and wait for participation", correct: true, why: "Right. A level clearing without volume usually means few holders actually changed their minds, and price often drifts back inside." },
        { text: "Short it, low volume means it will fail", why: "Low volume weakens the bullish case; it is not a bearish signal on its own. Volume is a filter, not a trigger." },
      ],
    },
  },

  // ── Risk ──────────────────────────────────────────────────────────────────
  {
    id: "position-sizing",
    level: "Risk",
    title: "Position sizing: the 1% rule",
    minutes: 5,
    summary: "Your stop decides how many shares you buy. Not the other way round.",
    body: `
Most people pick a share count first, usually "however much feels right," and
discover the risk afterwards. That is backwards, and it is the most expensive
habit in retail trading.

The correct order:

1. Decide the maximum you will lose on one trade, as a percentage of the account.
2. Find your entry and your stop on the chart.
3. Divide.

<!---->

    Risk per share = entry - stop
    Shares         = (account x risk %) / risk per share

On a 25,000 account risking 1%, you are willing to lose 250. If your entry is
100 and your stop is 96, you are risking 4 a share, so you buy 62 shares. Not
because 62 feels right, but because 62 is the number that makes the loss exactly
what you decided.

### Why 1%

At 1% per trade, ten consecutive losses costs about 10% of the account. That is
unpleasant and entirely survivable. At 10% per trade, the same losing streak
takes roughly 65% of the account, and you now need a 186% gain to recover.

Losses compound against you asymmetrically. Lose 50% and you need 100% to get
back. This is not a psychological argument, it is arithmetic, and it is the
reason professionals size small enough that being wrong repeatedly is boring.

### The part people miss

Volatile stocks get **smaller** positions, not larger. A wide stop means fewer
shares for the same dollar risk. Sizing every position identically in share
count means your risk is being decided by whichever stock happens to move most,
which is the opposite of controlling it.
`.trim(),
    live: (f) => f.equity == null ? null :
      `On your settings, ${f.riskPct}% of ${money(f.equity)} is **${money(f.equity * f.riskPct / 100)}** at risk per trade. If a setup's stop is $2 below entry, that is ${Math.floor(f.equity * f.riskPct / 100 / 2).toLocaleString()} shares. If the stop is $8 away, it is ${Math.floor(f.equity * f.riskPct / 100 / 8).toLocaleString()}.`,
    check: {
      q: "Account 50,000, risking 1%. Entry 80, stop 75. How many shares?",
      options: [
        { text: "100 shares", correct: true, why: "Right. 1% of 50,000 is 500 at risk. Risk per share is 80 - 75 = 5. 500 / 5 = 100 shares." },
        { text: "625 shares, so the position is 50,000", why: "That sizes to the account, not to the risk. A 5 point stop on 625 shares loses 3,125, over six times the intended risk." },
        { text: "500 shares, one per dollar of risk", why: "That confuses total risk with risk per share. 500 shares here would lose 2,500 at the stop." },
      ],
    },
  },
  {
    id: "stops",
    level: "Risk",
    title: "Where a stop actually goes",
    minutes: 5,
    summary: "A stop marks the price that proves you wrong, not the loss you can stomach.",
    body: `
A stop is not a comfort level. It is a statement: **if price reaches here, my
reason for being in this trade no longer exists.** That definition does the work,
because it means the stop is located by the chart rather than by your feelings
about losing money.

### Two ways people get this wrong

**Stop set by pain tolerance.** "I can afford to lose 200, so I'll stop out 200
below." The market has no idea what your pain threshold is. This puts the stop
at a random price, usually somewhere ordinary noise will reach.

**Stop set at the obvious level exactly.** If a level at 50 has held twice, the
stop cluster sits just under 50, and that liquidity is visible to everyone. Price
routinely dips through it and recovers. Give structure a buffer, sized in ATR,
not a round number.

### The method

1. Find the level that invalidates your thesis. A swing low, a breakout base, a
   moving average you are trading against.
2. Place the stop beyond it, buffered by roughly 0.5 to 1 ATR so ordinary
   movement does not reach it.
3. Check the total distance is between about 1 and 3 ATR. Tighter and noise
   ends the trade. Wider and the stop is not really bounding the loss.
4. Now size the position so that distance equals your fixed dollar risk.

If step 4 produces a position too large to be comfortable, the answer is fewer
shares, never a closer stop. Moving the stop to fit the size you wanted is how
a planned 1R loss becomes an unplanned 4R one.

### Never widen it

Moving a stop further away while in a trade converts a decision you made calmly
into one you are making under pressure, at the worst possible moment. If you
find yourself doing it, the position is too big. That is the real signal.
`.trim(),
    criterion: "Stop distance",
    check: {
      q: "You are long, price is approaching your stop, and you feel certain the thesis is still valid. What is the disciplined action?",
      options: [
        { text: "Widen the stop to give the trade room", why: "This is the single most common way a small planned loss becomes a large unplanned one. You are re-deciding under pressure." },
        { text: "Let the stop do its job, and re-enter later if the setup re-forms", correct: true, why: "Right. The stop encoded your invalidation when you were thinking clearly. Nothing stops you taking the trade again on a fresh signal." },
        { text: "Add to the position to lower the average cost", why: "Adding to a loser increases risk on the trade that is already going against you, and abandons the loss you had defined." },
      ],
    },
  },
  {
    id: "r-multiples",
    level: "Risk",
    title: "R-multiples and expectancy",
    minutes: 5,
    summary: "Stop counting dollars. Count R, and your results become comparable.",
    body: `
Once every trade risks the same amount, you can stop thinking in dollars and
start thinking in **R**. One R is your planned risk. A trade that hits its stop
is -1R. One that makes three times the risk is +3R. A 200 loss and a 2,000 loss
are both -1R if that is what you sized them to.

This is not a cosmetic change. Dollar results are not comparable across
positions of different size, so a P&L curve tells you about your position sizing
as much as about your decisions. R strips the sizing out and leaves the quality
of the decisions.

### Expectancy

Expectancy is the average R per trade:

    Expectancy = (win rate x avg win in R) - (loss rate x avg loss in R)

At 40% win rate, average win 2.5R and average loss 1R:

    (0.40 x 2.5) - (0.60 x 1) = 1.0 - 0.6 = +0.4R per trade

Positive expectancy means the process makes money over enough trades, whatever
the last five did. Negative expectancy means it loses money no matter how good
the last five felt. Everything else is noise around that number.

### The sample size problem

Expectancy is meaningless on small samples. At a 40% win rate, five straight
losses happen roughly 8% of the time, which is often. You cannot tell a bad
system from an ordinary losing streak inside ten trades, which is precisely why
sharpEdge refuses to show you a hit rate until you have enough drills for the
number to mean anything.

Judge the process on dozens of samples. Judge each individual trade on whether
you followed it.
`.trim(),
    live: (f) => f.avgR == null || f.drills < 5 ? null :
      `Across ${f.drills} graded drills your average outcome is **${f.avgR >= 0 ? "+" : ""}${f.avgR.toFixed(2)}R** per resolved trade. Positive means the plans you commit to have an edge; a small sample still means treat it lightly.`,
    check: {
      q: "Win rate 35%, average win 3R, average loss 1R. Is the expectancy positive?",
      options: [
        { text: "Yes, about +0.4R per trade", correct: true, why: "Right. (0.35 x 3) - (0.65 x 1) = 1.05 - 0.65 = +0.40R. Losing most trades and still making money is normal at this payoff." },
        { text: "No, you lose 65% of the time", why: "Win rate alone cannot answer this. The payoff on the winners more than covers the frequency of the losers." },
        { text: "Impossible to say without dollar amounts", why: "R already normalises the dollars. That is the point of the unit." },
      ],
    },
  },
  {
    id: "concentration",
    level: "Risk",
    title: "Concentration: the risk you cannot see",
    minutes: 5,
    summary: "Eight positions that all move together is one position wearing a disguise.",
    body: `
You size every trade at 1% and feel well controlled. Then you notice all eight
holdings are semiconductors. On a bad day for the sector they do not move
independently; they move together. Your real risk was never 1% per position, it
was closer to 8% on a single bet.

**Correlation is the risk that hides behind good position sizing.**

### Three layers of it

**Sector.** The obvious one. Names in the same industry share the same demand
cycle, the same regulation and the same headlines.

**Factor.** Less obvious. Unprofitable high-growth names across completely
different industries can move together because they respond to the same thing,
usually interest rates. A software company and a biotech can be the same trade.

**Beta.** Your portfolio's sensitivity to the whole market. Beta 1.0 moves with
it. Above 1 amplifies it in both directions. A portfolio of high-beta names is a
leveraged bet on the market whether or not you intended one.

### The number to watch

Concentration is not automatically wrong. Concentrated portfolios build wealth,
and diversified ones preserve it. What is wrong is being concentrated **without
knowing it**, because then you cannot size for it.

The rule of thumb worth holding: if one sector is more than about 40% of your
book, you are running a sector bet, not a stock portfolio. That may be exactly
what you want. It should be a decision.

sharpEdge computes this for you on the Portfolio tab, splitting your equity by
sector and reporting portfolio beta with the share of your book it covers.
`.trim(),
    live: (f) => f.topSector == null || f.topSectorPct == null ? null :
      `Your largest sector is **${f.topSector}** at **${f.topSectorPct.toFixed(0)}%** of your stock exposure${f.beta != null ? `, and your portfolio beta is **${f.beta.toFixed(2)}**` : ""}. ${f.topSectorPct >= 40 ? "That is above the 40% mark, so you are running a sector bet. Worth being deliberate about it." : "That is below the 40% mark, so no single sector is dominating."}`,
    check: {
      q: "You hold six stocks, each risking 1%, and all six are regional banks. What is your real risk?",
      options: [
        { text: "1%, because each position is sized to 1%", why: "That holds only if the positions move independently. Six banks respond to the same rate moves and the same credit news." },
        { text: "Closer to 6%, because they are highly correlated", correct: true, why: "Right. Correlated positions behave like one larger position. Sizing controls per-name risk, not the bet you are actually making." },
        { text: "Zero, because six names is diversified", why: "Diversification is about correlation, not count. Six names in one industry is one bet held six ways." },
      ],
    },
  },
];

export const LESSON_BY_ID = new Map(LESSONS.map((l) => [l.id, l]));

/** Practice criterion -> the lesson that explains it, for the drill nudge.
 *  Explicit rather than derived from `criterion`: two lessons legitimately touch
 *  stop distance, and "Risk defined" is covered by the stops lesson even though
 *  that lesson is tagged with the criterion it explains best. */
export const CRITERION_LESSON: Record<string, string> = {
  "Risk defined": "stops",
  "Reward vs risk": "risk-reward",
  "Stop distance": "atr",
  "Entry realism": "trend-structure",
};
