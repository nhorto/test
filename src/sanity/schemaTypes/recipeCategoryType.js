import {TagIcon} from '@sanity/icons'
import {defineField, defineType} from 'sanity'

export const recipeCategoryType = defineType({
  name: 'recipeCategory',
  title: 'Recipe Category',
  type: 'document',
  icon: TagIcon,
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'description',
      type: 'text',
    }),
  ],
  preview: {
    select: {
      title: 'title',
    },
  },
})
