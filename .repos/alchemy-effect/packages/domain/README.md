# @alchemy.run/domain

A domain-driven design framework for [Effect](https://effect.website), part of [Alchemy](https://alchemy.run). Model your business as commands, aggregates, events, views, and policies. Test it in memory, then run it on Cloudflare Durable Objects without changing the model.

```sh
npm install @alchemy.run/domain effect
```

Commands ask for a change, the aggregate decides it, and events record what happened:

```typescript
// src/account.ts
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}

export class TooLarge extends Domain.Rejection("TooLarge", { max: Schema.Int }) {}

export class DepositMoney extends Domain.Command("DepositMoney", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [MoneyDeposited],
  rejects: [TooLarge],
  reply: { balance: Schema.Int },
}) {}

export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  commands: [DepositMoney],
  decide: {
    DepositMoney: (s, cmd) =>
      cmd.amount > 10_000
        ? new TooLarge({ max: 10_000 })
        : [new MoneyDeposited({ amount: cmd.amount, balanceAfter: s.balance + cmd.amount })],
  },
  evolve: {
    MoneyDeposited: (s, e) => ({ balance: e.balanceAfter }),
  },
  reply: {
    DepositMoney: (s) => ({ balance: s.balance }),
  },
}) {}

export class Bank extends Domain.Model("Bank", { aggregates: [Account] }) {}
```

Behaviour is tested as a story: given these events, when this command, then these events:

```typescript
// test/account.test.ts
import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import { Account, Bank, DepositMoney, MoneyDeposited, TooLarge } from "../src/account.ts";

const story = Story.make(Bank, {});
const account = Account.ref("a-1");

it.effect("deposits and replies with the balance", () =>
  story(
    Story.given(account, new MoneyDeposited({ amount: 50, balanceAfter: 50 })),
    Story.when(account, new DepositMoney({ amount: 100 })),
    Story.then(account, new MoneyDeposited({ amount: 100, balanceAfter: 150 })),
    Story.replied({ balance: 150 }),
  ),
);

it.effect("rejects large deposits", () =>
  story(
    Story.when(account, new DepositMoney({ amount: 20_000 })),
    Story.rejected(new TooLarge({ max: 10_000 })),
  ),
);
```

## Learn more

- [Domain on alchemy.run](https://alchemy.run/domain)
- [Tutorial](https://alchemy.run/domain/tutorial/part-1)
- [Running on Cloudflare](https://alchemy.run/domain/cloudflare)
