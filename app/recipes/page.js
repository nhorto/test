import localFont from "next/font/local";

import RecipeListing from "@/components/RecipeListing";
import SiteHeader from "@/components/SiteHeader";
import { client } from "@/sanity/lib/client";
import { ALL_RECIPES_QUERY } from "@/sanity/lib/queries";

const daysOfCharity = localFont({
  src: "../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

export default async function RecipesPage() {
  const recipes = await client.fetch(ALL_RECIPES_QUERY);

  return (
    <>
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath="/recipes"
      />
      <RecipeListing
        recipes={recipes ?? []}
        headingFontClassName={daysOfCharity.className}
      />
    </>
  );
}
