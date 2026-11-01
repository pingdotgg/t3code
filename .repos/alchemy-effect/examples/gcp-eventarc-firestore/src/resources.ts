import * as GCP from "alchemy/GCP";

/**
 * Eventarc only delivers Firestore events to triggers in the database's
 * own location, so the database and the trigger pin the same location.
 */
export const LOCATION = "us-central1";

/**
 * A named Firestore database in Native mode. Firestore change events come
 * from Native-mode databases only, and a named database keeps the
 * example's triggers from firing on anything else in the project.
 */
export const Shop = GCP.Firestore.Database("Shop", {
  location: LOCATION,
  type: "FIRESTORE_NATIVE",
});

/** An order as the API stores it at `orders/{id}`. */
export interface Order {
  item: string;
  quantity: number;
  createdAt: Date;
}
