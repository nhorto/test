import {defineArrayMember, defineField, defineType} from 'sanity'

export const recipeType = defineType({
  name: 'recipe',
  title: 'Recipe',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {
        source: 'title',
        maxLength: 96,
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'mainImage',
      title: 'Main Image',
      type: 'image',
      options: {
        hotspot: true,
      },
      fields: [
        defineField({
          name: 'alt',
          type: 'string',
          title: 'Alternative Text',
          validation: (Rule) => Rule.required(),
        }),
      ],
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      description: 'A brief introduction to the recipe (like the opening paragraph)',
      rows: 4,
    }),
    defineField({
      name: 'categories',
      title: 'Categories',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'reference',
          to: [{type: 'recipeCategory'}],
        }),
      ],
    }),
    defineField({
      name: 'ingredientGroups',
      title: 'Ingredient Groups',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'text',
          title: 'Ingredient',
          rows: 2,
        }),
      ],
      description: 'Add each ingredient line as free-form text.',
    }),
    defineField({
      name: 'instructions',
      title: 'Instructions',
      type: 'array',
      of: [
        {
          type: 'object',
          name: 'step',
          fields: [
            {
              name: 'stepNumber',
              title: 'Step Number',
              type: 'number',
              readOnly: true,
            },
            {
              name: 'instruction',
              title: 'Instruction',
              type: 'text',
              rows: 3,
              validation: (Rule) => Rule.required(),
            },
          ],
          preview: {
            select: {
              instruction: 'instruction',
            },
            prepare({instruction}, index) {
              return {
                title: `Step ${index + 1}`,
                subtitle: instruction?.substring(0, 60) + '...',
              }
            },
          },
        },
      ],
    }),
    defineField({
      name: 'notes',
      title: 'Recipe Notes',
      type: 'array',
      of: [{type: 'block'}],
      description: 'Storage tips, substitutions, variations, etc.',
    }),
    defineField({
      name: 'publishedAt',
      title: 'Published At',
      type: 'datetime',
    }),
  ],
  preview: {
    select: {
      title: 'title',
      media: 'mainImage',
    },
  },
})
