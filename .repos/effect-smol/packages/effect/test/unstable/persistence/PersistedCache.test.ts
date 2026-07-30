import { Persistence } from "effect/unstable/persistence"
import * as PersistedCacheTest from "./PersistedCacheTest.ts"

PersistedCacheTest.suite("memory", Persistence.layerMemory)
