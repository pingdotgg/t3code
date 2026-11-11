export type Movie = {
  id: string;
  title: string;
  release_date: string;
};

export type MovieDetails = Movie & {
  director: string;
  producer: string;
};
