import { PersistedQueue } from "effect/unstable/persistence"
import * as PersistedQueueTest from "./PersistedQueueTest.ts"

PersistedQueueTest.suite("memory", PersistedQueue.layerStoreMemory)
