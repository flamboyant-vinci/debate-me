// Motion bank. Mixed themes and difficulty so the draw feels like a real tab.
import type { Motion } from "../../src/shared/types.ts";

export const MOTIONS: Motion[] = [
  {
    id: "m-social-media-minors",
    text: "This House would ban social media for under-16s",
    theme: "Technology & Society",
    difficulty: "novice",
  },
  {
    id: "m-jury-trials",
    text: "This House would abolish trial by jury",
    theme: "Criminal Justice",
    difficulty: "novice",
  },
  {
    id: "m-private-schools",
    text: "This House would abolish private schools",
    theme: "Education",
    difficulty: "novice",
  },
  {
    id: "m-ubi",
    text: "This House would replace all means-tested welfare with an unconditional basic income",
    theme: "Economics",
    difficulty: "open",
  },
  {
    id: "m-mandatory-voting",
    text: "This House would make voting compulsory",
    theme: "Politics",
    difficulty: "novice",
  },
  {
    id: "m-ai-liability",
    text:
      "This House would hold developers of general-purpose AI systems strictly liable for harms caused by " +
      "their downstream deployment",
    theme: "Technology & Law",
    difficulty: "open",
  },
  {
    id: "m-resource-nationalism",
    text:
      "This House, as a developing state with significant critical mineral reserves, would nationalise its " +
      "extraction industry",
    infoslide:
      "Critical minerals (lithium, cobalt, rare earths) are essential inputs to batteries and electronics. " +
      "Most extraction in developing states is currently operated by foreign multinationals under long-term " +
      "concession agreements, which provide reliable royalty revenue and technical expertise but limited " +
      "domestic value capture.",
    theme: "International Development",
    difficulty: "hard",
  },
  {
    id: "m-protest-movements",
    text:
      "This House believes that social movements should prioritise incremental legislative wins over " +
      "transformative demands",
    theme: "Social Movements",
    difficulty: "open",
  },
  {
    id: "m-parental-licensing",
    text: "This House regrets the narrative that parenthood is the central source of meaning in life",
    theme: "Philosophy & Culture",
    difficulty: "open",
  },
  {
    id: "m-sanctions",
    text: "This House believes that comprehensive economic sanctions do more harm than good",
    theme: "International Relations",
    difficulty: "open",
  },
  {
    id: "m-drug-legalisation",
    text: "This House would legalise the production and sale of all currently illicit drugs",
    theme: "Public Policy",
    difficulty: "open",
  },
  {
    id: "m-truth-commissions",
    text:
      "This House, as a state emerging from a violent authoritarian period, would grant amnesty to " +
      "perpetrators in exchange for full public testimony",
    infoslide:
      "Truth and reconciliation commissions trade criminal prosecution for a complete public record of " +
      "abuses. Prosecutions are slow, evidentially difficult, and often reach only a handful of senior " +
      "figures; amnesty-for-testimony reaches far more perpetrators but delivers no punishment.",
    theme: "Transitional Justice",
    difficulty: "hard",
  },
  {
    id: "m-billionaire-philanthropy",
    text: "This House regrets large-scale private philanthropy",
    theme: "Economics & Ethics",
    difficulty: "open",
  },
  {
    id: "m-remote-work",
    text: "This House believes that the shift to remote work has harmed early-career workers",
    theme: "Labour",
    difficulty: "novice",
  },
  {
    id: "m-climate-litigation",
    text:
      "This House prefers a world where climate policy is driven primarily by courts rather than " +
      "legislatures",
    theme: "Environment & Law",
    difficulty: "hard",
  },
  {
    id: "m-national-service",
    text: "This House would introduce a year of compulsory national civilian service",
    theme: "Politics",
    difficulty: "novice",
  },
  {
    id: "m-algorithmic-feeds",
    text: "This House would require large platforms to offer a chronological feed by default",
    theme: "Technology & Society",
    difficulty: "open",
  },
  {
    id: "m-identity-casting",
    text:
      "This House believes that the creative industries should abandon the principle that identity should " +
      "determine who may tell a story",
    theme: "Arts & Identity",
    difficulty: "hard",
  },
  {
    id: "m-migrant-remittances",
    text:
      "This House, as a developing state, would actively encourage the emigration of its skilled workers",
    theme: "Development",
    difficulty: "hard",
  },
  {
    id: "m-prison-abolition",
    text: "This House would abolish prisons for all non-violent offences",
    theme: "Criminal Justice",
    difficulty: "open",
  },
];

export function pickMotion(difficulty?: Motion["difficulty"], exclude: string[] = []): Motion {
  const pool = MOTIONS.filter(
    (m) => (!difficulty || m.difficulty === difficulty) && !exclude.includes(m.id),
  );
  const from = pool.length ? pool : MOTIONS;
  return from[Math.floor(Math.random() * from.length)];
}
