import {blockContentType} from './blockContentType'
import {blogCategoryType} from './blogCategoryType'
import {blogType} from './blogType'
import {recipeCategoryType} from './recipeCategoryType'
import {recipeType} from './recipeType'
import {seoType} from './seoType'

export const schema = {
  types: [blogCategoryType, blogType, blockContentType, recipeCategoryType, recipeType, seoType],
}
