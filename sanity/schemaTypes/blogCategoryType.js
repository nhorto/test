import {TagIcon} from '@sanity/icons'
import {defineField, defineType} from 'sanity'

export const blogCategoryType = defineType({
  name: 'blogCategory',
  title: 'Blog Category',
  type: 'document',
  icon: TagIcon,
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'description',
      type: 'text',
    }),
  ],
})
