import {defineQuery} from 'next-sanity'

const publishedAtWithFallback = 'coalesce(publishedAt, _createdAt)'

const blogCardFields = `
  "id": _id,
  title,
  "slug": slug.current,
  "category": coalesce(categories[0]->title, "Uncategorized"),
  "publishedAt": ${publishedAtWithFallback},
  "description": coalesce(excerpt, ""),
  "seoDescription": coalesce(seo.metaDescription, ""),
  excerpt,
  body,
  mainImage{
    asset,
    alt
  }
`

const recipeCardFields = `
  "id": _id,
  title,
  "slug": slug.current,
  "category": coalesce(categories[0]->title, "Uncategorized"),
  "publishedAt": ${publishedAtWithFallback},
  "description": coalesce(description, pt::text(notes)[0...500], ""),
  mainImage{
    asset->,
    alt
  }
`

export const ALL_BLOG_POSTS_QUERY = defineQuery(`
  *[_type == "blogPost" && defined(slug.current)] | order(${publishedAtWithFallback} desc) {
    ${blogCardFields}
  }
`)

export const ALL_RECIPES_QUERY = defineQuery(`
  *[_type == "recipe" && defined(slug.current)] | order(${publishedAtWithFallback} desc) {
    ${recipeCardFields}
  }
`)

export const LATEST_BLOG_POSTS_QUERY = defineQuery(`
  *[_type == "blogPost" && defined(slug.current)] | order(${publishedAtWithFallback} desc)[0...3] {
    ${blogCardFields}
  }
`)

export const LATEST_RECIPES_QUERY = defineQuery(`
  *[_type == "recipe" && defined(slug.current)] | order(${publishedAtWithFallback} desc)[0...3] {
    ${recipeCardFields}
  }
`)

export const BLOG_POST_BY_SLUG_QUERY = defineQuery(`
  *[_type == "blogPost" && slug.current == $slug][0]{
    _id,
    _updatedAt,
    title,
    "slug": slug.current,
    "publishedAt": ${publishedAtWithFallback},
    "excerpt": coalesce(pt::text(body)[0...200], ""),
    body,
    mainImage{
      asset->,
      alt
    },
    seo{
      metaTitle,
      metaDescription,
      canonicalUrl,
      noindex,
      ogImage{
        asset->,
        alt
      },
      twitter{
        card,
        image{
          asset->,
          alt
        }
      }
    },
    "categories": categories[]->title
  }
`)

export const RECIPE_BY_SLUG_QUERY = defineQuery(`
  *[_type == "recipe" && slug.current == $slug][0]{
    _id,
    _updatedAt,
    title,
    "slug": slug.current,
    description,
    "publishedAt": ${publishedAtWithFallback},
    mainImage{
      asset->,
      alt
    },
    seo{
      metaTitle,
      metaDescription,
      canonicalUrl,
      noindex,
      ogImage{
        asset->,
        alt
      },
      twitter{
        card,
        image{
          asset->,
          alt
        }
      }
    },
    "categories": categories[]->title,
    ingredientGroups,
    instructions[]{
      stepNumber,
      instruction
    },
    notes
  }
`)
