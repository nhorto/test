import Image from "next/image";
import localFont from "next/font/local";
import Link from "next/link";
import { notFound } from "next/navigation";

import PortableTextRenderer from "@/components/PortableTextRenderer";
import SiteHeader from "@/components/SiteHeader";
import { client } from "@/sanity/lib/client";
import { RECIPE_BY_SLUG_QUERY } from "@/sanity/lib/queries";
import { urlFor } from "@/sanity/lib/image";
import { formatDateWithDetail } from "@/utils/content";

const daysOfCharity = localFont({
  src: "../../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

export default async function RecipePage({ params }) {
  const { slug } = params ?? {};

  if (!slug) {
    notFound();
  }

  const recipe = await client.fetch(RECIPE_BY_SLUG_QUERY, { slug });

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

  return (
    <>
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath={`/recipes/${slug}`}
      />

      <article className="bg-[#FFF6F9] pb-20">
        <div className="mx-auto flex max-w-4xl flex-col gap-10 px-6 pt-16 lg:px-12">
          <div className="flex flex-col gap-6 text-[#253C57]">
            <div className="flex flex-wrap gap-3">
              {categories.map((category) => (
                <span
                  key={category}
                  className="rounded-full bg-[#253C57] px-4 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-white"
                >
                  {category}
                </span>
              ))}
            </div>

            <div>
              <h1
                className={`${daysOfCharity.className} text-4xl font-normal leading-[1.1] sm:text-5xl lg:text-6xl`}
              >
                {recipe.title}
              </h1>
              {publishedLabel && (
                <p className="mt-4 text-sm font-semibold uppercase tracking-[0.25em] text-[#8C7866]">
                  {publishedLabel}
                </p>
              )}
              {recipe.description && (
                <p className="mt-6 text-lg leading-[1.8] text-[#4B433C]">
                  {recipe.description}
                </p>
              )}
            </div>
          </div>

          {imageUrl && (
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-3xl bg-[#253C57]/10">
              <Image
                src={imageUrl}
                alt={imageAlt}
                fill
                className="object-cover"
                priority
                sizes="(min-width: 1024px) 64rem, (min-width: 640px) 80vw, 90vw"
              />
            </div>
          )}

          <div className="grid gap-10 rounded-3xl bg-white/80 p-8 shadow-md ring-1 ring-[#253C57]/10 sm:p-10 lg:grid-cols-[1fr_1.3fr]">
            <section>
              <h2 className="text-xl font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
                Ingredients
              </h2>
              {ingredients.length === 0 ? (
                <p className="mt-4 text-base text-[#4B433C]">
                  Ingredients coming soon.
                </p>
              ) : (
                <ul className="mt-4 list-disc space-y-3 pl-5 text-base text-[#4B433C]">
                  {ingredients.map((ingredient, index) => (
                    <li key={`${ingredient}-${index}`}>{ingredient}</li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h2 className="text-xl font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
                Instructions
              </h2>
              {instructions.length === 0 ? (
                <p className="mt-4 text-base text-[#4B433C]">
                  Instructions coming soon.
                </p>
              ) : (
                <ol className="mt-4 space-y-4">
                  {instructions.map((instruction, index) => {
                    const stepNumber =
                      instruction?.stepNumber ??
                      index + 1;
                    return (
                      <li
                        key={`${instruction.instruction}-${index}`}
                        className="flex gap-4"
                      >
                        <span className="h-8 w-8 shrink-0 rounded-full bg-[#253C57] text-center text-sm font-semibold leading-8 text-white">
                          {stepNumber}
                        </span>
                        <p className="text-base leading-[1.75] text-[#4B433C]">
                          {instruction.instruction}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </div>

          {recipe.notes && (
            <div className="rounded-3xl bg-white/80 p-8 shadow-md ring-1 ring-[#253C57]/10 sm:p-10">
              <h2 className="text-xl font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
                Notes & Tips
              </h2>
              <div className="mt-4">
                <PortableTextRenderer value={recipe.notes} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-4">
            <Link
              href="/recipes"
              className="inline-flex items-center justify-center rounded-full bg-[#253C57] px-6 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-white transition hover:bg-[#1C2D40]"
            >
              Back to All Recipes
            </Link>
          </div>
        </div>
      </article>
    </>
  );
}
