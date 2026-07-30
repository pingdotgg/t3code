import { Optic, Schema } from "effect"
import { Bench } from "tinybench"

/*
┌─────────┬──────────────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬──────────┐
│ (index) │ Task name        │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples  │
├─────────┼──────────────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼──────────┤
│ 0       │ 'iso get'        │ '907.53 ± 1.06%' │ '834.00 ± 1.00'  │ '1159005 ± 0.02%'      │ '1199041 ± 1439'       │ 1101891  │
│ 1       │ 'optic get'      │ '32.79 ± 0.20%'  │ '42.00 ± 1.00'   │ '25353263 ± 0.00%'     │ '23809524 ± 580720'    │ 30500447 │
│ 2       │ 'direct get'     │ '23.12 ± 0.48%'  │ '41.00 ± 1.00'   │ '32734753 ± 0.01%'     │ '24390244 ± 580720'    │ 43255789 │
│ 3       │ 'iso replace'    │ '2693.0 ± 2.87%' │ '2459.0 ± 41.00' │ '396398 ± 0.03%'       │ '406669 ± 6669'        │ 371349   │
│ 4       │ 'direct replace' │ '848.59 ± 0.45%' │ '792.00 ± 1.00'  │ '1244301 ± 0.02%'      │ '1262626 ± 1596'       │ 1178430  │
└─────────┴──────────────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴──────────┘
*/

const bench = new Bench()

// Define a class with nested properties
class User extends Schema.Class<User>("User")({
  id: Schema.Number,
  profile: Schema.Struct({
    name: Schema.String,
    email: Schema.String,
    address: Schema.Struct({
      street: Schema.String,
      city: Schema.String,
      country: Schema.String
    })
  })
}) {}

// Create a user instance
const user = User.make({
  id: 1,
  profile: {
    name: "John Doe",
    email: "john@example.com",
    address: {
      street: "123 Main St",
      city: "New York",
      country: "USA"
    }
  }
})

const iso = Schema.toIso(User).key("profile").key("address").key("street")
const optic = Optic.id<typeof User["Type"]>().key("profile").key("address").key("street")

bench
  .add("iso get", function() {
    iso.get(user)
  })
  .add("optic get", function() {
    optic.get(user)
  })
  .add("direct get", function() {
    // oxlint-disable-next-line no-unused-expressions
    user.profile.address.street
  })
  .add("iso replace", function() {
    iso.replace("Updated", user)
  })
  .add("direct replace", function() {
    // oxlint-disable-next-line no-new
    new User({
      ...user,
      profile: {
        ...user.profile,
        address: {
          ...user.profile.address,
          street: "Updated"
        }
      }
    })
  })

await bench.run()

console.table(bench.table())
