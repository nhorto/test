import Image from "next/image";
import localFont from "next/font/local";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import SiteHeader from "@/components/SiteHeader";
import PortableTextRenderer from "@/components/PortableTextRenderer";
import { client } from "@/sanity/lib/client";
import { RECIPE_BY_SLUG_QUERY } from "@/sanity/lib/queries";
import { urlFor } from "@/sanity/lib/image";
import { formatDateWithDetail } from "@/utils/content";
import SiteFooter from "@/components/SiteFooter";
import SocialLinks from "@/components/SocialLinks";
import CopyLinkButton from "@/components/CopyLinkButton";

const daysOfCharity = localFont({
  src: "../../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

const cleanString = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const toAbsoluteUrl = (path) => {
  try {
    return new URL(path, BASE_URL).toString();
  } catch {
    return path;
  }
};

const getRecipe = cache(async (slug) => {
  if (!slug) {
    return null;
  }

  return client.fetch(RECIPE_BY_SLUG_QUERY, { slug });
});

export async function generateMetadata({ params }) {
  const slug = typeof params?.slug === "string" ? params.slug : undefined;

  if (!slug) {
    return {};
  }

  const recipe = await getRecipe(slug);

  if (!recipe) {
    return {};
  }

  const title = cleanString(recipe.seo?.metaTitle) ?? recipe.title;
  const description =
    cleanString(recipe.seo?.metaDescription) ?? cleanString(recipe.description) ?? "";
  const canonical = cleanString(recipe.seo?.canonicalUrl) ?? toAbsoluteUrl(`/recipes/${recipe.slug}`);

  const shareImageSource =
    recipe.seo?.ogImage?.asset ? recipe.seo.ogImage : recipe.mainImage?.asset ? recipe.mainImage : null;
  const ogImageUrl = shareImageSource
    ? urlFor(shareImageSource).width(1200).height(630).fit("crop").url()
    : undefined;
  const ogImageAlt =
    cleanString(recipe.seo?.ogImage?.alt) ??
    cleanString(shareImageSource?.alt) ??
    `Featured image for ${recipe.title}`;

  const twitterImageSource = recipe.seo?.twitter?.image?.asset
    ? recipe.seo.twitter.image
    : shareImageSource;
  const twitterImageUrl = twitterImageSource
    ? urlFor(twitterImageSource).width(1200).height(630).fit("crop").url()
    : undefined;
  const twitterCard = recipe.seo?.twitter?.card ?? "summary_large_image";

  const robots = recipe.seo?.noindex ? { index: false, follow: true } : undefined;

  const other = {};
  if (recipe.publishedAt) {
    other["article:published_time"] = recipe.publishedAt;
  }
  if (recipe._updatedAt) {
    other["article:modified_time"] = recipe._updatedAt;
  }
  other["article:section"] = "Recipe";

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    robots,
    openGraph: {
      type: "article",
      url: canonical,
      siteName: "Holistic Bravo",
      locale: "en_US",
      title,
      description,
      publishedTime: recipe.publishedAt ?? undefined,
      modifiedTime: recipe._updatedAt ?? undefined,
      images: ogImageUrl
        ? [
            {
              url: ogImageUrl,
              alt: ogImageAlt,
            },
          ]
        : undefined,
    },
    twitter: {
      card: twitterCard,
      site: "@holisticbravo",
      creator: "@holisticbravo",
      title,
      description,
      images: twitterImageUrl ? [twitterImageUrl] : undefined,
    },
    ...(Object.keys(other).length ? { other } : {}),
  };
}

function IngredientListCard({ items }) {
  if (items.length === 0) {
    return (
      <div className="rounded-[2.5rem] border border-[#9F4F7C] bg-white px-8 py-10 shadow-sm sm:px-10 sm:py-12">
        <h2 className="text-xl  text-center font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
          Ingredients
        </h2>
        <p className="mt-6 text-base text-[#4B433C]">
          Ingredients coming soon.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[2.5rem] border border-[#9F4F7C] bg-[#EBD3DD] px-8 py-10 shadow-sm sm:px-10 sm:py-12">
      <h2 className="text-xl  text-center font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
        Ingredients
      </h2>
      <ul className="mt-8 space-y-5">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>
            <p className="text-base leading-relaxed text-[#4B433C]">{item}</p>
            {index !== items.length - 1 && (
              <span className="mt-4 block h-px w-full bg-[#9F4F7C]/60" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InstructionsList({ steps }) {
  if (steps.length === 0) {
    return (
      <div>
        <h2 className="text-xl font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
          Instructions
        </h2>
        <p className="mt-6 text-base text-[#4B433C]">
          Instructions coming soon.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl text-center font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
        Instructions
      </h2>
      <ol className="space-y-6">
        {steps.map((instruction, index) => {
          const stepNumber = instruction?.stepNumber ?? index + 1;
          return (
            <li
              key={`${instruction?.instruction}-${index}`}
              className="flex items-start gap-5"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EBD3DD] text-sm font-semibold text-[#9F4F7C]">
                {stepNumber}
              </span>
              <div className="flex-1">
                <p className="text-base leading-relaxed text-[#4B433C]">
                  {instruction?.instruction}
                </p>
                {index !== steps.length - 1 && (
                  <div className="mt-4 h-px w-full bg-[#E6C9D4]/50" />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ShareRecipeRow({ className = "" }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-6 ${className}`.trim()}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.35em] text-[#4B433C]">
        Share This Recipe
      </p>
      <div className="flex items-center gap-4">
        <SocialLinks
          wrapperClassName="flex items-center gap-4"
          itemClassName="flex h-12 w-12 items-center justify-center rounded-full border border-[#E6C9D4] text-[#2B2723] transition hover:bg-[#69ACC1]"
          iconClassName="text-xl"
          iconSizePx={22}
        />
        <CopyLinkButton
          className="flex h-12 w-12 items-center justify-center rounded-full border border-[#E6C9D4] text-[#2B2723] transition hover:bg-[#69ACC1]"
          iconClassName="text-xl"
          iconSizePx={22}
        />
      </div>
    </div>
  );
}

export default async function RecipePage({ params }) {
  const slug = typeof params?.slug === "string" ? params.slug : undefined;

  if (!slug) {
    notFound();
  }

  const recipe = await getRecipe(slug);

  if (!recipe) {
    notFound();
  }

  const imageUrl =
    recipe.mainImage?.asset &&
    urlFor(recipe.mainImage).width(1600).height(900).fit("crop").url();
  const imageAlt =
    recipe.mainImage?.alt || `Featured image for ${recipe.title}`;
  const categories = Array.isArray(recipe.categories)
    ? recipe.categories.filter(Boolean)
    : [];
  const ingredients = Array.isArray(recipe.ingredientGroups)
    ? recipe.ingredientGroups.filter((ingredient) => ingredient?.trim())
    : [];
  const instructions = Array.isArray(recipe.instructions)
    ? recipe.instructions.filter((instruction) => instruction?.instruction?.trim())
    : [];
  const publishedLabel = formatDateWithDetail(recipe.publishedAt);

  // Recipe JSON-LD Schema for Google rich results
  const recipeSchema = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: recipe.title,
    description: recipe.description || recipe.seo?.metaDescription || "",
    image: imageUrl ? [imageUrl] : [],
    author: {
      "@type": "Person",
      name: "Holistic Bravo",
      url: BASE_URL,
    },
    datePublished: recipe.publishedAt,
    dateModified: recipe._updatedAt || recipe.publishedAt,
    recipeCategory: categories.length > 0 ? categories[0] : "Main Course",
    keywords: categories.join(", ") || "vegetarian, vegan, plant-based",
    recipeIngredient: ingredients,
    recipeInstructions: instructions.map((instruction, index) => ({
      "@type": "HowToStep",
      name: `Step ${index + 1}`,
      text: instruction.instruction,
      position: index + 1,
    })),
    recipeYield: recipe.servings || undefined,
    prepTime: recipe.prepTime || undefined,
    cookTime: recipe.cookTime || undefined,
    totalTime: recipe.totalTime || undefined,
    suitableForDiet: ["https://schema.org/VegetarianDiet", "https://schema.org/VeganDiet"],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(recipeSchema) }}
      />
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath={`/recipes/${slug}`}
      />

      <section className="relative overflow-hidden bg-[#FFF6F9] pb-20">
        <div className="relative mx-auto max-w-7xl px-6 pt-16 lg:px-12 lg:pt-24">
          <Link
            href="/recipes"
            className="inline-flex items-center text-sm font-semibold uppercase tracking-[0.3em] text-[#2B2723] transition hover:text-[#4B433C]"
          >
            <span className="mr-3 flex h-6 w-6 items-center justify-center rounded-full border border-[#2B2723]/40">
              <span className="block h-2.5 w-2.5 -rotate-45 border-b-2 border-l-2 border-[#2B2723]" />
            </span>
            Back to Recipes
          </Link>

          <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:gap-16">
            <div className="flex flex-col gap-8 text-[#2B2723] lg:gap-10">
              {categories.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  {categories.map((category) => (
                    <span
                      key={category}
                      className="rounded-full bg-[#69ACC1] px-4 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723]"
                    >
                      {category}
                    </span>
                  ))}
                </div>
              )}

              {publishedLabel && (
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
                  {publishedLabel}
                </p>
              )}

              <h1
                className={`${daysOfCharity.className} text-4xl text-center font-normal leading-[1.1] sm:text-5xl lg:text-left lg:text-6xl`}
              >
                {recipe.title}
              </h1>

              {recipe.description && (
                <p className="text-lg leading-[1.8] text-[#4B433C] lg:max-w-xl lg:text-left">
                  {recipe.description}
                </p>
              )}
            </div>

            <div className="lg:pl-6">
              {imageUrl ? (
                <div className="overflow-hidden rounded-[3rem] bg-white shadow-xl ring-1 ring-[#E6C9D4]/70">
                  <Image
                    src={imageUrl}
                    alt={imageAlt}
                    width={1600}
                    height={1200}
                    className="h-auto w-full object-cover"
                    priority
                    sizes="(min-width: 1280px) 44rem, (min-width: 1024px) 40rem, (min-width: 640px) 80vw, 92vw"
                  />
                </div>
              ) : (
                <div className="rounded-[3rem] bg-[#69ACC1]">
                  <div className="py-[50%]" />
                </div>
              )}
            </div>
          </div>

          <div className="mt-16 border-t border-[#E6C9D4]/60 pt-10">
            <ShareRecipeRow />
          </div>
        </div>
      </section>

      <section className="bg-[#FFF6F9] pb-24">
        <div className="mx-auto max-w-5xl px-6">
          <div className="space-y-16">
            <IngredientListCard items={ingredients} />
            <InstructionsList steps={instructions} />

            {recipe.notes && (
              <div className="text-[#4B433C]">
                <h2 className="text-xl text-center font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
                  Notes & Tips
                </h2>
                <div className="mt-4 text-center">
                  <PortableTextRenderer value={recipe.notes} />
                </div>
              </div>
            )}

            <div className="border-t border-[#E6C9D4]/60 pt-10">
              <ShareRecipeRow />
            </div>
          </div>

          <div className="mt-12 flex justify-center">
            <Link
              href="/recipes"
              className="inline-flex items-center justify-center rounded-full bg-[#69ACC1] px-8 py-3 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723] transition hover:bg-[#D6E6F5]"
            >
              Back to All Recipes
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter logoClassName={daysOfCharity.className} />
    </>
  );
}
