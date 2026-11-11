// https://vike.dev/data

import { useConfig } from "vike-react/useConfig";
import type { PageContextServer } from "vike/types";
import type { MovieDetails } from "../types.js";

export type Data = Awaited<ReturnType<typeof data>>;

export async function data(pageContext: PageContextServer) {
  // https://vike.dev/useConfig
  const config = useConfig();

  const response = await fetch(
    `https://brillout.github.io/star-wars/api/films/${pageContext.routeParams.id}.json`,
  );
  let movie = (await response.json()) as MovieDetails;

  config({
    // Set <title>
    title: movie.title,
  });

  // We remove data we don't need because the data is passed to
  // the client; we should minimize what is sent over the network.
  movie = minimize(movie);

  return { movie };
}

function minimize(movie: MovieDetails): MovieDetails {
  const { id, title, release_date, director, producer } = movie;
  return { id, title, release_date, director, producer };
}
