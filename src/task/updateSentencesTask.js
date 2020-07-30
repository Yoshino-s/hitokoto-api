/* eslint-disable node/no-deprecated-api */
const path = require('path')
const fs = require('fs')

const winston = require('winston')
const colors = require('colors')
const semver = require('semver')
const _ = require('lodash')

const cache = require('../cache')
const AB = require('../extensions/sentencesABSwitcher')

function load (p) {
  return {
    data: JSON.parse(fs.readFileSync(p))
  }
}

async function Task () {
  // TODO: 按需同步流程中移除失效句子（在包中移除的句子）
  winston.verbose('[sentencesUpdateTask] start to update...')
  const startTick = Date.now()
  // 取得 AB 库的指针
  const currentABSlot = await cache.get('hitokoto:ab') || 'a'
  AB.setDatabase(currentABSlot)
  // 取得本地数据版本
  const localBundleVersion = await AB.get('hitokoto:bundle:version') || '0.0.0'
  const localBundleUpdatedAt = await AB.get('hitokoto:bundle:updated_at') || 0
  const localBundleVersionData = await AB.get('hitokoto:bundle:version:record') || {}
  // 获取远程数据的版控文件
  const sentencePath = path.join(__dirname, '../../sentences/')
  const sentenceVersion = path.resolve(sentencePath, './version.json')
  winston.verbose('[sentencesUpdateTask] fetching version data from: ' + sentenceVersion)
  let response = load(sentenceVersion)
  const versionData = response.data

  winston.verbose('[sentencesUpdateTask] bundle protocal version: ' + colors.green('v' + versionData.protocol_version))
  if (!semver.satisfies(versionData.protocol_version, '>=1.0 <1.1')) {
    winston.error('[sentencesUpdateTask] This program version is NOT support the protocol version: ' + versionData.protocol_version + ', please update your program.')
    return
  }
  winston.verbose('[sentencesUpdateTask] bundle version: ' + colors.yellow('v' + versionData.bundle_version))
  winston.verbose('[sentencesUpdateTask] local bundle version: ' + colors.yellow('v' + localBundleVersion))
  if (semver.eq(versionData.bundle_version, localBundleVersion) && localBundleUpdatedAt === versionData.updated_at) {
    winston.verbose('[sentencesUpdateTask] The local records are same with the one, update ended.')
    return // 版本相同且生成时间戳相同、无需更新
  }
  // 需要更新，首先确认本地版本
  const targetDatabase = currentABSlot === 'a' ? 'b' : 'a'
  const SideAB = AB.getConnection(targetDatabase)
  let sentenceTotal = 0
  if (localBundleVersion === '0.0.0') { // 初次启动、全量同步数据
    // 获取分类数据
    const categoriesPath = path.resolve(sentencePath, versionData.categories.path)
    winston.verbose('[sentencesUpdateTask] fetching categroies data from: ' + colors.green(categoriesPath))
    response = load(categoriesPath)
    const categoriesData = response.data
    await SideAB.set('hitokoto:bundle:categories', categoriesData)

    const rClient = SideAB.getClient()
    for (const category of categoriesData) {
      // 读取分类的数据
      const categoryPath = path.resolve(sentencePath, category.path)
      winston.verbose('[sentencesUpdateTask] fetching sentences data from: ' + colors.green(categoryPath))
      response = load(categoryPath)
      const categorySentences = response.data
      let minLength
      let maxLength
      for (const sentence of categorySentences) {
        // generate Length range
        if (!minLength) {
          minLength = sentence.length
        }
        if (!maxLength) {
          maxLength = sentence.length
        }
        if (sentence.length < minLength) {
          minLength = sentence.length
        } else if (sentence.length > maxLength) {
          maxLength = sentence.length
        }
        await Promise.all([
          SideAB.set('hitokoto:sentence:' + sentence.uuid, sentence),
          rClient.zaddAsync(['hitokoto:bundle:category:' + category.key, sentence.length, sentence.uuid])
        ])
      }
      // 保存句子长度范围
      await SideAB.set(`hitokoto:bundle:category:${category.key}:max`, maxLength)
      await SideAB.set(`hitokoto:bundle:category:${category.key}:min`, minLength)
      sentenceTotal += categorySentences.length
    }
  } else { // 挨个比对，按需求同步
    // 首先比对分类信息
    const localCategoriesData = SideAB.get('hitokoto:bundle:categories') || []
    if (localCategoriesData.length === 0) {
      await SideAB.set('hitokoto:bundle:version', '0.0.0')
      RunTask()
      return
    }
    const rClient = SideAB.getClient()
    if (!versionData.categories.timestamp !== localBundleVersionData.categories.timestamp) {
      // 读取远端分类信息
      const categoriesPath = path.resolve(sentencePath, versionData.categories.path)
      winston.verbose('[sentencesUpdateTask] fetching categroies data from: ' + colors.green(categoriesPath))
      response = load(categoriesPath)
      const categoryData = response.data

      const categoriedNeededToAppend = []
      for (const category of categoryData) {
        const c = _.find(localCategoriesData, { key: category.key })
        if (!c) {
          categoriedNeededToAppend.push(category)
        }
      }
      for (const category of categoriedNeededToAppend) {
        // 读取分类的数据
        const sentencesPath = path.resolve(sentencePath, category.path)
        winston.verbose('[sentencesUpdateTask] fetching sentences data from: ' + colors.green(sentencesPath))
        response = load(sentencesPath)
        const categorySentences = response.data
        let minLength
        let maxLength
        for (const sentence of categorySentences) {
          // generate Length range
          if (!minLength) {
            minLength = sentence.length
          }
          if (!maxLength) {
            maxLength = sentence.length
          }
          if (sentence.length < minLength) {
            minLength = sentence.length
          } else if (sentence.length > maxLength) {
            maxLength = sentence.length
          }
          await Promise.all([
            SideAB.set('hitokoto:sentence:' + sentence.uuid, sentence),
            rClient.zaddAsync(['hitokoto:bundle:category:' + category.key, sentence.length, sentence.uuid])
          ])
        }
        // 保存句子长度范围
        await SideAB.set(`hitokoto:bundle:category:${category.key}:max`, maxLength)
        await SideAB.set(`hitokoto:bundle:category:${category.key}:min`, minLength)
      }
      await SideAB.set('hitokoto:bundle:categories', categoryData)
    }

    // 然后比对句子信息
    for (const categoryVersion of localBundleVersionData.sentences) {
      const version = _.find(versionData, { key: categoryVersion.key })
      if (!version) {
        // 多半是此分类被删除
        continue
      }
      if (version.timestamp !== categoryVersion.timestamp) { // 需要更新
        const sentencesPath = path.resolve(sentencePath, categoryVersion.path)
        winston.verbose('[sentencesUpdateTask] fetching sentences data from: ' + colors.green(sentencesPath))
        response = load(sentencesPath)
        const categorySentences = response.data
        const queue = (await cache.getClient()).multi()
        queue.del('hitokoto:bundle:category:' + categoryVersion.key)
        let minLength
        let maxLength
        for (const sentence of categorySentences) {
          // generate Length range
          if (!minLength) {
            minLength = sentence.length
          }
          if (!maxLength) {
            maxLength = sentence.length
          }
          if (sentence.length < minLength) {
            minLength = sentence.length
          } else if (sentence.length > maxLength) {
            maxLength = sentence.length
          }
          queue.set('hitokoto:sentence:' + sentence.uuid, sentence)
          queue.zadd(['hitokoto:bundle:category:' + categoryVersion.key, sentence.length, sentence.uuid])
        }
        // 保存句子长度范围
        await queue.set(`hitokoto:bundle:category:${queue.key}:max`, maxLength)
        await queue.set(`hitokoto:bundle:category:${queue.key}:min`, minLength)
        await queue.execAsync()
        queue.quit() // 结束连接
      }
    }

    // 获得句子总数，由于以上的增量实现无法正确统计，因此咱们用一个偷懒的方法（以后优化）
    const categories = await SideAB.get('hitokoto:bundle:categories')
    for (const category of categories) {
      sentenceTotal += Number.parseInt(await SideAB.command('zcount', ['hitokoto:bundle:category:' + category.key, '0', '+inf']))
    }
  }

  // 更新版本记录
  await Promise.all([
    SideAB.set('hitokoto:bundle:version', versionData.bundle_version),
    SideAB.set('hitokoto:bundle:updated_at', versionData.updated_at),
    SideAB.set('hitokoto:bundle:version:record', versionData),
    SideAB.set('hitokoto:bundle:sentences:total', sentenceTotal)
  ])
  // 切换数据库
  AB.setDatabase(targetDatabase)
  cache.set('hitokoto:ab', targetDatabase)
  winston.verbose('[sentencesUpdateTask] total sentences: ' + colors.cyan(sentenceTotal))
  winston.verbose('[sentencesUpdateTask] having finished the update, spend ' + (Date.now() - startTick) + ' ms.')
  if (process.send) { // is in CronProcess
    winston.verbose('[sentencesUpdateTask] notify master process to switch redis db to: ' + colors.yellow(targetDatabase))
    process.send({
      key: 'switchAB',
      to: 'ab',
      data: targetDatabase,
      matchFrom: true
    })
  }
}

function RunTask () {
  Task()
    .catch(err => {
      console.log(colors.red(err.stack))
      winston.error('[sentencesUpdateTask] occur errors while update, please check the details. if occurs frequently, contact the author please.')
    })
}

module.exports = {
  RunTask,
  Task
}
