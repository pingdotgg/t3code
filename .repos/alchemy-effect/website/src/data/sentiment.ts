/**
 * Public posts about Alchemy, curated from X (see the sentiment thread at
 * https://x.com/samgoodwin89/status/2102459555573793216) and the public
 * channels of the Alchemy Discord. Text is verbatim except for trimming,
 * marked with "…". Only first-party team posts are excluded.
 */
export interface Post {
  name: string;
  handle: string;
  url: string;
  text: string;
  /** Where the post lives. @default "x" */
  source?: "x" | "discord";
}

const DISCORD = "https://discord.com/channels/1359694195782320389";

export const POSTS: Post[] = [
  {
    name: "Rhys",
    handle: "RhysSullivan",
    url: "https://x.com/RhysSullivan/status/2102515675931799843",
    text: "Alchemy enables me to be more ambitious in shipping large projects to multiple targets. It gives my agents the capability to debug issues against real deployments of my systems, enabling the best feedback loop I've ever had resulting in several large perf wins.",
  },
  {
    name: "Maxwell Brown",
    handle: "maxwellbrown",
    url: "https://x.com/maxwellbrown/status/2081323853171556739",
    text: "Alchemy is literally the only reason I gave Cloudflare's dev platform a shot. The fact that I can just write Effect code to describe / deploy my infra and then use those same resources in my program is unparalleled DX IMO.",
  },
  {
    name: "Maximilian",
    handle: "maxedapps",
    url: "https://x.com/maxedapps/status/2099771815786582351",
    text: "Cloudflare + Alchemy + Effect is such a winning stack with AI agents, it's not even real. … And all the infra lives in code - which is how it should be with AI agents.",
  },
  {
    name: "Dillon Mulroy",
    handle: "dillon_mulroy",
    url: "https://x.com/dillon_mulroy/status/2081108173935522081",
    text: "alchemy is so good for IAC, esp. cloudflare IAC",
  },
  {
    name: "Michael Arnaldi",
    handle: "MichaelArnaldi",
    url: "https://x.com/MichaelArnaldi/status/2102384731912388802",
    text: "Thanks to Alchemy the CF primitives finally shine in DX, I couldn't get over the DX issues before, now it's amazing",
  },
  {
    name: "arth",
    handle: "arthty",
    url: "https://x.com/arthty/status/2090156386353299742",
    text: "choosing alchemy as a core foundation on @op0ai is probably a top 3 decision long-term. so far, the dx and velocity has gone thru the roof.",
  },
  {
    name: "Nick Blow",
    handle: "NickBlow",
    url: "https://x.com/NickBlow/status/2102814433315578050",
    text: "The fact it's truly \u201cjust typescript\u201d and not the abomination of codegen … Allows it to be far more easily extended than other iac platforms.",
  },
  {
    name: "Superlinear",
    handle: "superlinear_fm",
    url: "https://x.com/superlinear_fm/status/2101946564260294900",
    text: "We use @alchemy_run bc it's truly declarative, written in TypeScript with Effect, and gives agents a clean, code-native way to understand and modify infrastructure.",
  },
  {
    name: "Michael Arnaldi",
    handle: "MichaelArnaldi",
    url: "https://x.com/MichaelArnaldi/status/2100076857638957346",
    text: "Effect + Alchemy + DOs (and cf primitives) is an insanely powerful combo",
  },
  {
    name: "Alireza Najafi",
    handle: "alire8za",
    url: "https://x.com/alire8za/status/2102777097148068137",
    text: "Alchemy made working with Cloudflare joyful",
  },
  {
    name: "joel",
    handle: "joelhooks",
    url: "https://x.com/joelhooks/status/2102230916164886939",
    text: "nobody talking about the effect+alchemy+cloudflare combo to literally build f'n anything",
  },
  {
    name: "Harry Solovay",
    handle: "harrysolovay",
    url: "https://x.com/harrysolovay/status/2081854670960488857",
    text: "It just hit me: @alchemy_run is going to Effect-pill literally everyone who wants to ditch Wrangler. ... that's pretty magical.",
  },
  {
    name: "Andrew Jefferson",
    handle: "EastlondonDev",
    url: "https://x.com/EastlondonDev/status/1944020116955361658",
    text: "Alchemy is next gen infrastructure as code & it's helping us make the most of Cloudflare's global scale",
  },
  {
    name: "Nipsuli",
    handle: "Nipsuli",
    url: "https://x.com/Nipsuli/status/2090153816289079318",
    text: "Alchemy is freaking amazing! I've run with cloudflare workers for few years now in different projects and alchemy made the experience so freaking much better.",
  },
  {
    name: "Michael Arnaldi",
    handle: "MichaelArnaldi",
    url: "https://x.com/MichaelArnaldi/status/2094818796204634535",
    text: "v4 + alchemy solved most of the issues, we are now focusing on higher level design of things like Cluster on CF",
  },
  {
    name: "skuse",
    handle: "skuse_",
    url: `${DISCORD}/1359694196830765059/1494113753766039703`,
    text: "Man I've been here 2 days and this is such an underrated project, having my whole stack defined as code even things like stripe is a complete game changer. Define the code, dump the necessary outputs into my servers env, just works. Testing / isolating environments has become trivial whereas before I'd have to click around dashboards.",
    source: "discord",
  },
  {
    name: "carlo",
    handle: "seitandelivery",
    url: `${DISCORD}/1430044817211260938/1496933941410529300`,
    text: "… I just read the v2 docs and I never thought iac could be this good 😍 seriously, this is a game changer for me. Thank you all for the hard work 🫶 alchemy will be my new obsession this year haha",
    source: "discord",
  },
  {
    name: "dan myles",
    handle: "danmyles_",
    url: `${DISCORD}/1502003721771679826/1550582476324216943`,
    text: "IaC is a no brainer for anything bigger than a vibecoded saas\njust too much custom tooling required for dev stages etc on TF/pulumi\nwhy i love alchemy!",
    source: "discord",
  },
  {
    name: "artem",
    handle: "flowisgreat",
    url: `${DISCORD}/1424860521772875827/1424861389398479019`,
    text: "using alchemy for conare.ai and it's awesome - thanks for the hard work!\n\nhaving all of the backend directly as code is a game changer for AI",
    source: "discord",
  },
  {
    name: "Ray",
    handle: "xesrevinu",
    url: `${DISCORD}/1373936446032842803/1544618939202412597`,
    text: "Alchemy architecture is really amazing. It's really amazing work. I feel that you have made such an excellent project.",
    source: "discord",
  },
  {
    name: "Dill",
    handle: "dillionv",
    url: `${DISCORD}/1373936446032842803/1552394945497669753`,
    text: "… rn use some janky pulumi / terraform deploy process and would rather just migrate it all to effect + alchemy",
    source: "discord",
  },
  {
    name: "david",
    handle: "davidlbowman",
    url: `${DISCORD}/1430044817211260938/1499872994082689204`,
    text: "… what i love about alchemy-effect, is i already write 100% effect code, but quite a few of my clients are smaller, and only need a static site, some webhook handlers, maybe a workflow, and it's nice to be able to quickly create those layers. … so far, it's been great.",
    source: "discord",
  },
  {
    name: "Alessandro",
    handle: "alessandroc00c",
    url: `${DISCORD}/1430044817211260938/1527797668695244800`,
    text: "… i am loving alchemy and im spinning up s***t like crazy",
    source: "discord",
  },
];

/** Profile photo, saved from X into public/testimonials (96px WebP). */
const DISCORD_AVATARS: Record<string, string> = {
  skuse_: "skuse",
  seitandelivery: "carlo",
  danmyles_: "danmyles",
  flowisgreat: "artem",
  xesrevinu: "ray",
  dillionv: "dill",
  davidlbowman: "david",
  alessandroc00c: "alessandro",
};
export const avatar = (p: Post) =>
  p.source === "discord"
    ? `/testimonials/discord-${DISCORD_AVATARS[p.handle]}.webp`
    : `/testimonials/${p.handle.toLowerCase()}.webp`;

const by = (url: string) => POSTS.find((p) => p.url.endsWith(url))!;

/**
 * The wall's three columns, top to bottom. The first row is the most
 * important voices (Rhys, Michael Arnaldi, Maxwell Brown, then Dillon
 * Mulroy); the rest follow in rank order (strongest sentiment, most detail
 * about Alchemy first), spread across the columns so the wall reads
 * roughly by rank and the columns end at about the same height.
 */
export const WALL_COLUMNS: Post[][] = [
  [
    by("2102515675931799843"), // Rhys
    by("2099771815786582351"), // Maximilian
    by("2101946564260294900"), // Superlinear
    by("1496933941410529300"), // carlo (Discord)
    by("1944020116955361658"), // Andrew Jefferson
    by("1552394945497669753"), // Dill (Discord)
    by("1527797668695244800"), // Alessandro (Discord)
    by("2102777097148068137"), // Alireza Najafi
  ],
  [
    by("2102384731912388802"), // Michael Arnaldi, CF primitives
    by("2081108173935522081"), // Dillon Mulroy
    by("2102814433315578050"), // Nick Blow
    by("2090156386353299742"), // arth
    by("1424861389398479019"), // artem (Discord)
    by("2090153816289079318"), // Nipsuli
    by("2100076857638957346"), // Michael Arnaldi, DOs combo
    by("2102230916164886939"), // joel
  ],
  [
    by("2081323853171556739"), // Maxwell Brown
    by("1494113753766039703"), // skuse (Discord)
    by("1499872994082689204"), // david (Discord)
    by("2081854670960488857"), // Harry Solovay
    by("1550582476324216943"), // dan myles (Discord)
    by("2094818796204634535"), // Michael Arnaldi, Cluster on CF
    by("1544618939202412597"), // Ray (Discord)
  ],
];
