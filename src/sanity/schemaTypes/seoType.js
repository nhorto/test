import {defineField, defineType} from 'sanity'

export const seoType = defineType({
  name: 'seo',
  title: 'SEO',
  type: 'object',
  fields: [
    defineField({
      name: 'metaTitle',
      title: 'Meta Title',
      type: 'string',
      validation: (Rule) => Rule.max(70).warning('Keep meta title under ~70 characters'),
    }),
    defineField({
      name: 'metaDescription',
      title: 'Meta Description',
      type: 'text',
      rows: 3,
      validation: (Rule) => Rule.max(160).warning('Keep meta description under ~160 characters'),
    }),
    defineField({
      name: 'ogImage',
      title: 'Social Share Image',
      type: 'image',
      options: {
        hotspot: true,
      },
      fields: [
        defineField({
          name: 'alt',
          title: 'Alt text',
          type: 'string',
        }),
      ],
    }),
    defineField({
      name: 'canonicalUrl',
      title: 'Canonical URL',
      type: 'url',
      validation: (Rule) =>
        Rule.uri({
          allowRelative: false,
        }),
    }),
    defineField({
      name: 'noindex',
      title: 'Discourage indexing (noindex)',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'twitter',
      title: 'Twitter Overrides',
      type: 'object',
      fields: [
        defineField({
          name: 'card',
          title: 'Card Type',
          type: 'string',
          options: {
            list: [
              {title: 'Summary', value: 'summary'},
              {title: 'Summary Large Image', value: 'summary_large_image'},
            ],
          },
        }),
        defineField({
          name: 'image',
          title: 'Twitter Image',
          type: 'image',
          options: {
            hotspot: true,
          },
          fields: [
            defineField({
              name: 'alt',
              title: 'Alt text',
              type: 'string',
            }),
          ],
        }),
      ],
    }),
  ],
})
