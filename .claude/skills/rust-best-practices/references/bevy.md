# Bevy (digest)

Sources: the Bevy 0.20 API docs (https://docs.rs/bevy/0.20.0 and
https://docs.rs/bevy_ecs/0.20.0), Bevy's own lint configuration in its published
`Cargo.toml`, and the migration guides at https://bevy.org/learn/migration-guides/.
Checked against bevy 0.20.0 (October 2026); every behavior below was confirmed with a
test on that version. Read this when `Cargo.toml` depends on `bevy` or `bevy_ecs`.

Check the project's Bevy version first. Bevy breaks its API every release (0.17 renamed
events to messages, 0.20 changed the observer generics), so follow the version in
`Cargo.lock`, not this file, when they disagree.

Bevy calls your systems and builds their arguments, so a few general rules don't fit
system functions. The exceptions below replace them for Bevy code only. Everything else
in the skill (errors, panics, naming, tests, unsafe) still applies.

## Keep Bevy's conventions

**System parameters are taken by value.** `Res<T>`, `ResMut<T>`, `Query<D, F>`,
`Single<D, F>`, `Commands`, `Local<T>`, `MessageReader<M>`, and `MessageWriter<M>` are
already borrows that Bevy hands the system for one run. Don't change them to `&Res<T>`
or report them as needless pass-by-value. Normal borrowing advice still holds inside a
system and for helper functions it calls: pass `&Health`, not a whole `Query`.

**Use `use bevy::prelude::*`.** The prelude is Bevy's documented import pattern, and
clippy's `wildcard_imports` already exempts paths that contain `prelude`. The rule against
glob imports still applies to your own modules, so don't invent an application prelude.

**Plain-data components and resources may have public fields.** `Health(pub u32)` and
`Velocity(pub Vec2)` are passive data that many systems read and write, which is the
passive-data exception in SKILL.md section 4. Keep fields private only when the fields
must hold an invariant together, such as a list that must stay sorted. Settings such as
a regeneration rate and a cap are plain data: enforce the cap in the system that applies
it, not with getters and a panicking constructor.

**Complex queries and many parameters are normal.** Bevy's own workspace allows
`clippy::type_complexity` and `clippy::too_many_arguments`. Allow them at the crate
level, or give a query reused by several systems a `type` alias. Don't split a system or
wrap its queries in a custom `SystemParam` only to silence the lint; derive
`SystemParam` when a group of parameters is reused and deserves a name.

**Lints.** The BeautifulRust lints in `lints/lints.toml` turn on `rust_2018_idioms` and
clippy's pedantic group, which flag every idiomatic system signature. In a Bevy crate,
add these lines to the existing `[lints.rust]` and `[lints.clippy]` tables:

```toml
# under [lints.rust]
elided_lifetimes_in_paths = "allow"   # write Res<Time>, not Res<'_, Time>

# under [lints.clippy]
needless_pass_by_value = "allow"      # system parameters are passed by value
type_complexity = "allow"             # query types; Bevy's own workspace allows this
too_many_arguments = "allow"          # systems take many parameters; so does Bevy
```

## Correctness checks

These are the Bevy bugs that compile cleanly. Check every system for them when writing
or reviewing.

**Conflicting queries panic.** Two parameters of one system that could reach the same
component mutably compile, but the system panics with error B0001 the first time it
runs. `Query<&mut Health, With<Player>>` and `Query<&mut Health, With<Enemy>>`
conflict, because one entity could have both markers. A `Res<T>` next to a `ResMut<T>`
of the same type panics the same way (B0002). Make the queries disjoint with `Without`,
or put them in a `ParamSet` when they really overlap and are used one at a time. Choose
the filter that matches the game's rules, not whichever one compiles.

```rust
fn apply_hits(
    mut players: Query<&mut Health, (With<Player>, Without<Enemy>)>,
    mut enemies: Query<&mut Health, (With<Enemy>, Without<Player>)>,
) {
    // Each query now covers a separate set of entities.
}
```

**`Commands` are deferred.** `spawn`, `insert`, and `despawn` are queued and take effect
at the next sync point (`ApplyDeferred`). Bevy inserts one automatically between two
systems that have an explicit order (`.chain()`, `.before()`, `.after()`) when the
earlier one has `Commands`. Without an order, another system can run before the queued
changes apply and see the old world. A system that must see another system's spawns or
despawns needs an explicit order.

**Order systems that depend on each other.** Systems added in one tuple without
`.chain()` have no order, and Bevy may run them either way, frame to frame. If one
system reads what another writes in the same frame (a resource, a message, a component,
or a spawn), give them an order: `.chain()` for a pipeline, `.after()` for one edge, or
system sets for larger groups.

```rust
// check_wave_cleared must not run after spawn_wave's spawns are queued but not
// yet applied, or it sees no enemies and starts a second wave.
app.add_systems(Update, (check_wave_cleared, spawn_wave).chain());
```

**Don't unwrap queries.** `Query::single()` and `get(entity)` return `Result`, and
`.unwrap()` crashes the game when the player dies or a second camera appears. Use
`Single<D, F>`, which skips the system unless exactly one entity matches, or
`let Ok(..) = .. else { return };`. A system can also return `Result` and use `?`, but
Bevy's default error handler panics on the error. Install a quieter one if that's what
you want: `app.insert_resource(FallbackErrorHandler(warn))`.

```rust
fn contact_damage(player: Single<(Entity, &Position), With<Player>>) {
    let (player, position) = *player;
    // Runs only while exactly one player exists.
}
```

**Commands on an entity that may be gone.** A command on an entity that was despawned
earlier in the frame is an error when it applies, and the default handler panics. Guard
against despawning twice (two hits killing the same enemy in one frame), or use
`try_insert` and `try_despawn` when the entity may already be gone.

**Messages are read once per reader.** Each `MessageReader` sees a message once. A
reader that runs before the writer in a frame sees that message in the next frame, so
order a reader after its writer when it must react in the same frame.

## Testing systems

Drive systems through a headless `App` without `DefaultPlugins`. Insert the resources
the systems need, and advance `Time` by hand so the test is deterministic.

```rust
#[test]
fn units_move_by_velocity() {
    let mut app = App::new();
    app.init_resource::<Time>().add_systems(Update, move_units);
    let unit = app.world_mut().spawn((Position(Vec2::ZERO), Velocity(Vec2::X * 10.0))).id();
    app.world_mut().resource_mut::<Time>().advance_by(Duration::from_secs(2));

    app.update();

    assert_eq!(app.world().get::<Position>(unit), Some(&Position(Vec2::X * 20.0)));
}
```

Also add one smoke test that adds the whole plugin and calls `app.update()` twice.
Conflicting queries and missing resources only show up when a system first runs, so
tests that add systems one at a time can all pass while the plugin panics on its first
frame.
