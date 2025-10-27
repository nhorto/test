import { Suspense } from "react";

import localFont from "next/font/local";

import RecipeListing from "@/components/RecipeListing";
import SiteHeader from "@/components/SiteHeader";
import { client } from "@/sanity/lib/client";
import { ALL_RECIPES_QUERY } from "@/sanity/lib/queries";
import SiteFooter from "@/components/SiteFooter";

const daysOfCharity = localFont({
  src: "../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

export const metadata = {
  title: "Recipes - Plant-Based Vegetarian & Vegan Dishes",
  description: "Discover delicious, healthy plant-based recipes including vegetarian and vegan dishes. Nourishing meals for clean eating, holistic wellness, and a vibrant lifestyle from Holistic Bravo's kitchen.",
  openGraph: {
    title: "Recipes - Plant-Based Vegetarian & Vegan Dishes | Holistic Bravo",
    description: "Discover delicious, healthy plant-based recipes including vegetarian and vegan dishes. Nourishing meals for clean eating, holistic wellness, and a vibrant lifestyle.",
    type: "website",
    url: "/recipes",
    siteName: "Holistic Bravo",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Recipes - Plant-Based Vegetarian & Vegan Dishes",
    description: "Discover delicious, healthy plant-based recipes including vegetarian and vegan dishes from Holistic Bravo's kitchen.",
    site: "@holisticbravo",
    creator: "@holisticbravo",
  },
  alternates: {
    canonical: "/recipes",
  },
};

export default async function RecipesPage() {
  const recipes = await client.fetch(ALL_RECIPES_QUERY);

  return (
    <>
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath="/recipes"
      />
      <Suspense
        fallback={
          <div className="bg-[#FFF6F9] py-16 text-center text-[#2B2723]">
            Loading recipes…
          </div>
        }
      >
        <RecipeListing
          recipes={recipes ?? []}
          headingFontClassName={daysOfCharity.className}
        />
      </Suspense>
      <SiteFooter logoClassName={daysOfCharity.className} />
    </>
  );
}
