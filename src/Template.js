import util from "node:util";
import os from "node:os";
import path from "node:path";

import fs from "graceful-fs";
import lodash from "@11ty/lodash-custom";
import { DateTime } from "luxon";
import { TemplatePath, isPlainObject } from "@11ty/eleventy-utils";
import debugUtil from "debug";

import ConsoleLogger from "./Util/ConsoleLogger.js";
import getDateFromGitLastUpdated from "./Util/DateGitLastUpdated.js";
import getDateFromGitFirstAdded from "./Util/DateGitFirstAdded.js";
import TemplateData from "./Data/TemplateData.js";
import TemplateContent from "./TemplateContent.js";
import TemplatePermalink from "./TemplatePermalink.js";
import TemplateLayout from "./TemplateLayout.js";
import TemplateFileSlug from "./TemplateFileSlug.js";
import ComputedData from "./Data/ComputedData.js";
import Pagination from "./Plugins/Pagination.js";
import TemplateBehavior from "./TemplateBehavior.js";
import TemplateContentPrematureUseError from "./Errors/TemplateContentPrematureUseError.js";
import TemplateContentUnrenderedTemplateError from "./Errors/TemplateContentUnrenderedTemplateError.js";
import EleventyBaseError from "./Errors/EleventyBaseError.js";
import ReservedData from "./Util/ReservedData.js";

const { set: lodashSet, get: lodashGet } = lodash;
const writeFile = util.promisify(fs.writeFile);
const fsStat = util.promisify(fs.stat);

const debug = debugUtil("Eleventy:Template");
const debugDev = debugUtil("Dev:Eleventy:Template");

class EleventyTransformError extends EleventyBaseError {}
class EleventyReservedDataError extends TypeError {}

class Template extends TemplateContent {
	constructor(templatePath, templateData, extensionMap, config) {
		debugDev("new Template(%o)", templatePath);
		super(templatePath, config);

		this.parsed = path.parse(templatePath);

		// for pagination
		this.extraOutputSubdirectory = "";

		this.extensionMap = extensionMap;

		this.linters = [];
		this.transforms = [];

		this.setTemplateData(templateData);

		this.isVerbose = true;
		this.isDryRun = false;
		this.writeCount = 0;

		this.fileSlug = new TemplateFileSlug(this.inputPath, this.extensionMap, this.eleventyConfig);
		this.fileSlugStr = this.fileSlug.getSlug();
		this.filePathStem = this.fileSlug.getFullPathWithoutExtension();

		this.outputFormat = "fs";

		this.behavior = new TemplateBehavior(this.config);
		this.behavior.setOutputFormat(this.outputFormat);
	}

	setTemplateData(templateData) {
		this.templateData = templateData;
	}

	get existsCache() {
		return this.eleventyConfig.existsCache;
	}

	get logger() {
		if (!this._logger) {
			this._logger = new ConsoleLogger();
			this._logger.isVerbose = this.isVerbose;
		}
		return this._logger;
	}

	/* Setter for Logger */
	set logger(logger) {
		this._logger = logger;
	}

	setRenderableOverride(renderableOverride) {
		this.behavior.setRenderableOverride(renderableOverride);
	}

	reset() {
		this.writeCount = 0;
	}

	resetCaches(types) {
		types = this.getResetTypes(types);

		super.resetCaches(types);

		if (types.data) {
			delete this._dataCache;
		}

		if (types.render) {
			delete this._cacheRenderedContent;
			delete this._cacheFinalContent;
		}
	}

	setOutputFormat(to) {
		this.outputFormat = to;
		this.behavior.setOutputFormat(to);
	}

	setIsVerbose(isVerbose) {
		this.isVerbose = isVerbose;
		this.logger.isVerbose = isVerbose;
	}

	setDryRunViaIncremental() {
		this.isDryRun = true;
		this.isIncremental = true;
	}

	setDryRun(isDryRun) {
		this.isDryRun = !!isDryRun;
	}

	setExtraOutputSubdirectory(dir) {
		this.extraOutputSubdirectory = dir + "/";
	}

	getTemplateSubfolder() {
		return TemplatePath.stripLeadingSubPath(this.parsed.dir, this.inputDir);
	}

	getLayout(layoutKey) {
		// already cached downstream in TemplateLayout -> TemplateCache
		return TemplateLayout.getTemplate(layoutKey, this.eleventyConfig, this.extensionMap);
	}

	get baseFile() {
		return this.extensionMap.removeTemplateExtension(this.parsed.base);
	}

	get htmlIOException() {
		// HTML output can’t overwrite the HTML input file.
		return (
			this.inputDir === this.outputDir &&
			this.templateRender.isEngine("html") &&
			this.baseFile === "index"
		);
	}

	async _getRawPermalinkInstance(permalinkValue) {
		let perm = new TemplatePermalink(permalinkValue, this.extraOutputSubdirectory);
		perm.setUrlTransforms(this.config.urlTransforms);

		this.behavior.setFromPermalink(perm);

		return perm;
	}

	async _getLink(data) {
		if (!data) {
			throw new Error("data argument missing in Template->_getLink");
		}

		let permalink = data[this.config.keys.permalink];
		let permalinkValue;

		// `permalink: false` means render but no file system write, e.g. use in collections only)
		// `permalink: true` throws an error
		if (typeof permalink === "boolean") {
			debugDev("Using boolean permalink %o", permalink);
			permalinkValue = permalink;
		} else if (permalink && (!this.config.dynamicPermalinks || data.dynamicPermalink === false)) {
			debugDev("Not using dynamic permalinks, using %o", permalink);
			permalinkValue = permalink;
		} else if (isPlainObject(permalink)) {
			// Empty permalink {} object should act as if no permalink was set at all
			// and inherit the default behavior
			let isEmptyObject = Object.keys(permalink).length === 0;
			if (!isEmptyObject) {
				let promises = [];
				let keys = [];
				for (let key in permalink) {
					keys.push(key);
					if (key !== "build" && Array.isArray(permalink[key])) {
						promises.push(
							Promise.all([...permalink[key]].map((entry) => super.renderPermalink(entry, data))),
						);
					} else {
						promises.push(super.renderPermalink(permalink[key], data));
					}
				}

				let results = await Promise.all(promises);

				permalinkValue = {};
				for (let j = 0, k = keys.length; j < k; j++) {
					let key = keys[j];
					permalinkValue[key] = results[j];
					debug(
						"Rendering permalink.%o for %o: %s becomes %o",
						key,
						this.inputPath,
						permalink[key],
						results[j],
					);
				}
			}
		} else if (permalink) {
			// render variables inside permalink front matter, bypass markdown
			permalinkValue = await super.renderPermalink(permalink, data);
			debug("Rendering permalink for %o: %s becomes %o", this.inputPath, permalink, permalinkValue);
			debugDev("Permalink rendered with data: %o", data);
		}

		// Override default permalink behavior. Only do this if permalink was _not_ in the data cascade
		if (!permalink && this.config.dynamicPermalinks && data.dynamicPermalink !== false) {
			let permalinkCompilation = this.engine.permalinkNeedsCompilation("");
			if (typeof permalinkCompilation === "function") {
				let ret = await this._renderFunction(permalinkCompilation, permalinkValue, this.inputPath);
				if (ret !== undefined) {
					if (typeof ret === "function") {
						// function
						permalinkValue = await this._renderFunction(ret, data);
					} else {
						// scalar
						permalinkValue = ret;
					}
				}
			}
		}

		if (permalinkValue !== undefined) {
			return this._getRawPermalinkInstance(permalinkValue);
		}

		// No `permalink` specified in data cascade, do the default
		let p = TemplatePermalink.generate(
			this.getTemplateSubfolder(),
			this.baseFile,
			this.extraOutputSubdirectory,
			this.htmlIOException ? this.config.htmlOutputSuffix : "",
			this.engine.defaultTemplateFileExtension,
		);
		p.setUrlTransforms(this.config.urlTransforms);
		return p;
	}

	async usePermalinkRoot() {
		if (this._usePermalinkRoot === undefined) {
			// TODO this only works with immediate front matter and not data files
			let { data } = await this.getFrontMatterData();
			this._usePermalinkRoot = data[this.config.keys.permalinkRoot];
		}

		return this._usePermalinkRoot;
	}

	// TODO instead of htmlIOException, do a global search to check if output path = input path and then add extra suffix
	async getOutputLocations(data) {
		this.bench.get("(count) getOutputLocations").incrementCount();
		let link = await this._getLink(data);

		let path;
		if (await this.usePermalinkRoot()) {
			path = link.toPathFromRoot();
		} else {
			path = link.toPath(this.outputDir);
		}

		return {
			linkInstance: link,
			rawPath: link.toOutputPath(),
			href: link.toHref(),
			path: path,
		};
	}

	// This is likely now a test-only method
	// Preferred to use the singular `getOutputLocations` above.
	async getRawOutputPath(data) {
		this.bench.get("(count) getRawOutputPath").incrementCount();
		let link = await this._getLink(data);
		return link.toOutputPath();
	}

	// Preferred to use the singular `getOutputLocations` above.
	async getOutputHref(data) {
		this.bench.get("(count) getOutputHref").incrementCount();
		let link = await this._getLink(data);
		return link.toHref();
	}

	// Preferred to use the singular `getOutputLocations` above.
	async getOutputPath(data) {
		this.bench.get("(count) getOutputPath").incrementCount();
		let link = await this._getLink(data);
		if (await this.usePermalinkRoot()) {
			return link.toPathFromRoot();
		}
		return link.toPath(this.outputDir);
	}

	async _testGetAllLayoutFrontMatterData() {
		let { data: frontMatterData } = await this.getFrontMatterData();

		if (frontMatterData[this.config.keys.layout]) {
			let layout = this.getLayout(frontMatterData[this.config.keys.layout]);
			return await layout.getData();
		}
		return {};
	}

	async getData() {
		if (this._dataCache) {
			return this._dataCache;
		}

		debugDev("%o getData", this.inputPath);
		let localData = {};
		let globalData = {};

		if (this.templateData) {
			localData = await this.templateData.getTemplateDirectoryData(this.inputPath);
			globalData = await this.templateData.getGlobalData(this.inputPath);
			debugDev("%o getData getTemplateDirectoryData and getGlobalData", this.inputPath);
		}

		let { data: frontMatterData, excerpt } = await this.getFrontMatterData();
		let layoutKey =
			frontMatterData[this.config.keys.layout] ||
			localData[this.config.keys.layout] ||
			globalData[this.config.keys.layout];

		// Layout front matter data
		let mergedLayoutData = {};
		if (layoutKey) {
			let layout = this.getLayout(layoutKey);

			mergedLayoutData = await layout.getData();
			debugDev("%o getData merged layout chain front matter", this.inputPath);
		}

		try {
			let mergedData = TemplateData.mergeDeep(
				this.config.dataDeepMerge,
				{},
				globalData,
				mergedLayoutData,
				localData,
				frontMatterData,
			);

			let reserved = this.config.freezeReservedData ? ReservedData.getReservedKeys(mergedData) : [];
			if (reserved.length > 0) {
				let e = new EleventyReservedDataError(
					`Cannot override reserved Eleventy properties: ${reserved.join(", ")}`,
				);
				e.reservedNames = reserved;
				throw e;
			}

			this.addExcerpt(mergedData, excerpt);
			mergedData = await this.addPageDate(mergedData);
			mergedData = this.addPageData(mergedData);
			debugDev("%o getData mergedData", this.inputPath);

			this._dataCache = mergedData;

			return mergedData;
		} catch (e) {
			if (
				e instanceof EleventyReservedDataError ||
				(e instanceof TypeError &&
					e.message.startsWith("Cannot add property") &&
					e.message.endsWith("not extensible"))
			) {
				throw new EleventyBaseError(
					`You attempted to set one of Eleventy’s reserved data property names${e.reservedNames ? `: ${e.reservedNames.join(", ")}` : ""}. You can opt-out of this behavior with \`eleventyConfig.setFreezeReservedData(false)\` or rename/remove the property in your data cascade that conflicts with Eleventy’s reserved property names (e.g. \`eleventy\`, \`pkg\`, and others). Learn more: https://www.11ty.dev/docs/data-eleventy-supplied/`,
					e,
				);
			}
			throw e;
		}
	}

	async addPageDate(data) {
		if (!("page" in data)) {
			data.page = {};
		}

		let newDate = await this.getMappedDate(data);

		if ("page" in data && "date" in data.page) {
			debug(
				"Warning: data.page.date is in use (%o) will be overwritten with: %o",
				data.page.date,
				newDate,
			);
		}

		data.page.date = newDate;

		return data;
	}

	addPageData(data) {
		if (!("page" in data)) {
			data.page = {};
		}

		data.page.inputPath = this.inputPath;
		data.page.fileSlug = this.fileSlugStr;
		data.page.filePathStem = this.filePathStem;
		data.page.outputFileExtension = this.engine.defaultTemplateFileExtension;
		data.page.templateSyntax = this.templateRender.getEnginesList(
			data[this.config.keys.engineOverride],
		);

		return data;
	}

	// Tests only
	async render() {
		throw new Error("Internal error: `render` was removed from Template.js in Eleventy 3.0.");
	}

	async renderLayout() {
		throw new Error("Internal error: `renderLayout` was removed from Template.js in Eleventy 3.0.");
	}

	async renderDirect(str, data, bypassMarkdown) {
		return super.render(str, data, bypassMarkdown);
	}

	// This is the primary render mechanism, called via TemplateMap->populateContentDataInMap
	async renderPageEntryWithoutLayout(pageEntry) {
		if (this._cacheRenderedContent) {
			return this._cacheRenderedContent;
		}

		let renderedContent = await this.renderDirect(pageEntry.rawInput, pageEntry.data);

		this._cacheRenderedContent = renderedContent;
		return renderedContent;
	}

	addLinter(callback) {
		this.linters.push(callback);
	}

	async runLinters(str, page) {
		let { inputPath, outputPath, url } = page;
		let pageData = page.data.page;

		for (let linter of this.linters) {
			// these can be asynchronous but no guarantee of order when they run
			linter.call(
				{
					inputPath,
					outputPath,
					url,
					page: pageData,
				},
				str,
				inputPath,
				outputPath,
			);
		}
	}

	addTransform(name, callback) {
		this.transforms.push({
			name,
			callback,
		});
	}

	async runTransforms(str, page) {
		let { inputPath, outputPath, url } = page;
		let pageData = page.data.page;

		for (let { callback, name } of this.transforms) {
			try {
				let hadStrBefore = !!str;
				str = await callback.call(
					{
						inputPath,
						outputPath,
						url,
						page: pageData,
					},
					str,
					outputPath,
				);
				if (hadStrBefore && !str) {
					this.logger.warn(
						`Warning: Transform \`${name}\` returned empty when writing ${outputPath} from ${inputPath}.`,
					);
				}
			} catch (e) {
				throw new EleventyTransformError(
					`Transform \`${name}\` encountered an error when transforming ${inputPath}.`,
					e,
				);
			}
		}

		return str;
	}

	_addComputedEntry(computedData, obj, parentKey, declaredDependencies) {
		// this check must come before isPlainObject
		if (typeof obj === "function") {
			computedData.add(parentKey, obj, declaredDependencies);
		} else if (Array.isArray(obj) || isPlainObject(obj)) {
			for (let key in obj) {
				let keys = [];
				if (parentKey) {
					keys.push(parentKey);
				}
				keys.push(key);
				this._addComputedEntry(computedData, obj[key], keys.join("."), declaredDependencies);
			}
		} else if (typeof obj === "string") {
			computedData.addTemplateString(
				parentKey,
				async function (innerData) {
					return this.tmpl.renderComputedData(obj, innerData);
				},
				declaredDependencies,
				this.getParseForSymbolsFunction(obj),
				this,
			);
		} else {
			// Numbers, booleans, etc
			computedData.add(parentKey, obj, declaredDependencies);
		}
	}

	async addComputedData(data) {
		if (this.config.keys.computed in data) {
			this.computedData = new ComputedData(this.config);

			// Note that `permalink` is only a thing that gets consumed—it does not go directly into generated data
			// this allows computed entries to use page.url or page.outputPath and they’ll be resolved properly

			// TODO Room for optimization here—we don’t need to recalculate `getOutputHref` and `getOutputPath`
			// TODO Why are these using addTemplateString instead of add
			this.computedData.addTemplateString(
				"page.url",
				async function (data) {
					return this.tmpl.getOutputHref(data);
				},
				data.permalink ? ["permalink"] : undefined,
				false, // skip symbol resolution
				this,
			);

			this.computedData.addTemplateString(
				"page.outputPath",
				async function (data) {
					return this.tmpl.getOutputPath(data);
				},
				data.permalink ? ["permalink"] : undefined,
				false, // skip symbol resolution
				this,
			);

			// actually add the computed data
			this._addComputedEntry(this.computedData, data[this.config.keys.computed]);

			// limited run of computed data—save the stuff that relies on collections for later.
			debug("First round of computed data for %o", this.inputPath);
			await this.computedData.setupData(data, function (entry) {
				return !this.isUsesStartsWith(entry, "collections.");

				// TODO possible improvement here is to only process page.url, page.outputPath, permalink
				// instead of only punting on things that rely on collections.
				// let firstPhaseComputedData = ["page.url", "page.outputPath", ...this.getOrderFor("page.url"), ...this.getOrderFor("page.outputPath")];
				// return firstPhaseComputedData.indexOf(entry) > -1;
			});
		} else {
			if (!("page" in data)) {
				data.page = {};
			}

			// pagination will already have these set via Pagination->getPageTemplates
			if (data.page.url && data.page.outputPath) {
				return;
			}

			let { href, path } = await this.getOutputLocations(data);
			data.page.url = href;
			data.page.outputPath = path;
		}
	}

	// Computed data consuming collections!
	async resolveRemainingComputedData(data) {
		// If it doesn’t exist, computed data is not used for this template
		if (this.computedData) {
			debug("Second round of computed data for %o", this.inputPath);
			await this.computedData.processRemainingData(data);
		}
	}

	static augmentWithTemplateContentProperty(obj) {
		return Object.defineProperties(obj, {
			needsCheck: {
				enumerable: false,
				writable: true,
				value: true,
			},
			_templateContent: {
				enumerable: false,
				writable: true,
				value: undefined,
			},
			templateContent: {
				enumerable: true,
				set(content) {
					if (content === undefined) {
						this.needsCheck = false;
					}
					this._templateContent = content;
				},
				get() {
					if (this.needsCheck && this._templateContent === undefined) {
						if (this.template.behavior.isRenderable()) {
							// should at least warn here
							throw new TemplateContentPrematureUseError(
								`Tried to use templateContent too early on ${this.inputPath}${
									this.pageNumber ? ` (page ${this.pageNumber})` : ""
								}`,
							);
						} else {
							throw new TemplateContentUnrenderedTemplateError(
								`Tried to use templateContent on unrendered template. You need a valid permalink (or permalink object) to use templateContent on ${
									this.inputPath
								}${this.pageNumber ? ` (page ${this.pageNumber})` : ""}`,
							);
						}
					}
					return this._templateContent;
				},
			},
			// Alias for templateContent for consistency
			content: {
				enumerable: true,
				get() {
					return this.templateContent;
				},
				set() {
					throw new Error("Setter not available for `content`. Use `templateContent` instead.");
				},
			},
		});
	}

	async getTemplates(data) {
		let rawInput = await this.getPreRender();

		// https://github.com/11ty/eleventy/issues/1206
		data.page.rawInput = rawInput;

		if (!Pagination.hasPagination(data)) {
			await this.addComputedData(data);

			let obj = {
				template: this, // not on the docs but folks are relying on it
				rawInput,
				groupNumber: 0, // i18n plugin
				data,

				page: data.page,
				inputPath: this.inputPath,
				fileSlug: this.fileSlugStr,
				filePathStem: this.filePathStem,
				date: data.page.date,
				outputPath: data.page.outputPath,
				url: data.page.url,
			};

			obj = Template.augmentWithTemplateContentProperty(obj);

			return [obj];
		} else {
			// needs collections for pagination items
			// but individual pagination entries won’t be part of a collection
			this.paging = new Pagination(this, data, this.config);

			let pageTemplates = await this.paging.getPageTemplates();
			let objects = [];

			for (let pageEntry of pageTemplates) {
				await pageEntry.template.addComputedData(pageEntry.data);

				let obj = {
					template: pageEntry.template, // not on the docs but folks are relying on it
					rawInput,
					pageNumber: pageEntry.pageNumber,
					groupNumber: pageEntry.groupNumber || 0,

					data: pageEntry.data,

					inputPath: this.inputPath,
					fileSlug: this.fileSlugStr,
					filePathStem: this.filePathStem,

					page: pageEntry.data.page,
					date: pageEntry.data.page.date,
					outputPath: pageEntry.data.page.outputPath,
					url: pageEntry.data.page.url,
				};

				obj = Template.augmentWithTemplateContentProperty(obj);

				objects.push(obj);
			}

			return objects;
		}
	}

	async _write({ url, outputPath, data, rawInput }, finalContent) {
		let lang = {
			start: "Writing",
			finished: "written.",
		};

		if (!this.isDryRun) {
			let engineList = this.templateRender.getReadableEnginesListDifferingFromFileExtension();
			this.logger.log(
				`${lang.start} ${outputPath} from ${this.inputPath}${engineList ? ` (${engineList})` : ""}`,
			);
		} else if (this.isDryRun) {
			return;
		}

		let templateBenchmarkDir = this.bench.get("Template make parent directory");
		templateBenchmarkDir.before();

		let templateOutputDir = path.parse(outputPath).dir;
		if (templateOutputDir) {
			if (!this.existsCache.exists(templateOutputDir)) {
				fs.mkdirSync(templateOutputDir, { recursive: true });
			}
		}
		templateBenchmarkDir.after();

		if (!Buffer.isBuffer(finalContent) && typeof finalContent !== "string") {
			throw new Error(
				`The return value from the render function for the ${this.engine.name} template was not a String or Buffer. Received ${finalContent}`,
			);
		}

		let templateBenchmark = this.bench.get("Template Write");
		templateBenchmark.before();

		await writeFile(outputPath, finalContent);

		templateBenchmark.after();
		this.writeCount++;
		debug(`${outputPath} ${lang.finished}.`);

		let ret = {
			inputPath: this.inputPath,
			outputPath: outputPath,
			url,
			content: finalContent,
			rawInput,
		};

		if (data && this.config.dataFilterSelectors && this.config.dataFilterSelectors.size > 0) {
			ret.data = this.retrieveDataForJsonOutput(data, this.config.dataFilterSelectors);
		}

		return ret;
	}

	async renderPageEntry(pageEntry) {
		// cache with transforms output
		if (pageEntry.template._cacheFinalContent) {
			return pageEntry.template._cacheFinalContent;
		}

		let content;
		let layoutKey = pageEntry.data[this.config.keys.layout];
		if (layoutKey) {
			let layout = pageEntry.template.getLayout(layoutKey);
			content = await layout.renderPageEntry(pageEntry);
		} else {
			content = pageEntry.templateContent;
		}

		await this.runLinters(content, pageEntry);
		content = await this.runTransforms(content, pageEntry);

		pageEntry.template._cacheFinalContent = content;
		return content;
	}

	retrieveDataForJsonOutput(data, selectors) {
		let filtered = {};
		for (let selector of selectors) {
			let value = lodashGet(data, selector);
			lodashSet(filtered, selector, value);
		}
		return filtered;
	}

	async generateMapEntry(mapEntry, to) {
		let ret = [];

		for (let page of mapEntry._pages) {
			let content;

			// Note that behavior.render is overridden when using json or ndjson output
			if (page.template.behavior.isRenderable()) {
				// this reuses page.templateContent, it doesn’t render it
				content = await page.template.renderPageEntry(page);
			}

			if (to === "json" || to === "ndjson") {
				let obj = {
					url: page.url,
					inputPath: page.inputPath,
					outputPath: page.outputPath,
					rawInput: page.rawInput,
					content: content,
				};

				if (this.config.dataFilterSelectors && this.config.dataFilterSelectors.size > 0) {
					obj.data = this.retrieveDataForJsonOutput(page.data, this.config.dataFilterSelectors);
				}

				if (to === "ndjson") {
					let jsonString = JSON.stringify(obj);
					this.logger.toStream(jsonString + os.EOL);
					continue;
				}

				// json
				ret.push(obj);
				continue;
			}

			if (!page.template.behavior.isRenderable()) {
				debug("Template not written %o from %o.", page.outputPath, page.template.inputPath);
				continue;
			}

			if (!page.template.behavior.isWriteable()) {
				debug(
					"Template not written %o from %o (via permalink: false, permalink.build: false, or a permalink object without a build property).",
					page.outputPath,
					page.template.inputPath,
				);
				continue;
			}

			// compile returned undefined
			if (content !== undefined) {
				ret.push(this._write(page, content));
			}
		}

		return Promise.all(ret);
	}

	async clone() {
		// TODO do we need to even run the constructor here or can we simplify it even more
		let tmpl = new Template(
			this.inputPath,
			this.templateData,
			this.extensionMap,
			this.eleventyConfig,
		);

		// We use this cheap property setter below instead
		// await tmpl.getTemplateRender();

		// preserves caches too, e.g. _frontMatterDataCache
		for (let key in this) {
			tmpl[key] = this[key];
		}

		return tmpl;
	}

	getWriteCount() {
		return this.writeCount;
	}

	async getInputFileStat() {
		if (this._stats) {
			return this._stats;
		}

		this._stats = fsStat(this.inputPath);

		return this._stats;
	}

	async _getDateInstance(key = "birthtimeMs") {
		let stat = await this.getInputFileStat();

		// Issue 1823: https://github.com/11ty/eleventy/issues/1823
		// return current Date in a Lambda
		// otherwise ctime would be "1980-01-01T00:00:00.000Z"
		// otherwise birthtime would be "1970-01-01T00:00:00.000Z"
		if (stat.birthtimeMs === 0) {
			return new Date();
		}

		let newDate = new Date(stat[key]);

		debug(
			"Template date: using file’s %o for %o of %o (from %o)",
			key,
			this.inputPath,
			newDate,
			stat.birthtimeMs,
		);

		return newDate;
	}

	async getMappedDate(data) {
		if ("date" in data && data.date) {
			debug("getMappedDate: using a date in the data for %o of %o", this.inputPath, data.date);
			if (data.date instanceof Date) {
				// YAML does its own date parsing
				debug("getMappedDate: YAML parsed it: %o", data.date);
				return data.date;
			}

			// special strings
			if (!this.isVirtualTemplate()) {
				if (data.date.toLowerCase() === "git last modified") {
					let d = getDateFromGitLastUpdated(this.inputPath);
					if (d) {
						return d;
					}

					// return now if this file is not yet available in `git`
					return new Date();
				}
				if (data.date.toLowerCase() === "last modified") {
					return this._getDateInstance("ctimeMs");
				}
				if (data.date.toLowerCase() === "git created") {
					let d = getDateFromGitFirstAdded(this.inputPath);
					if (d) {
						return d;
					}

					// return now if this file is not yet available in `git`
					return new Date();
				}
				if (data.date.toLowerCase() === "created") {
					return this._getDateInstance("birthtimeMs");
				}
			}

			// try to parse with Luxon
			let date = DateTime.fromISO(data.date, { zone: "utc" });
			if (!date.isValid) {
				throw new Error(`date front matter value (${data.date}) is invalid for ${this.inputPath}`);
			}
			debug("getMappedDate: Luxon parsed %o: %o and %o", data.date, date, date.toJSDate());

			return date.toJSDate();
		} else {
			let filepathRegex = this.inputPath.match(/(\d{4}-\d{2}-\d{2})/);
			if (filepathRegex !== null) {
				// if multiple are found in the path, use the first one for the date
				let dateObj = DateTime.fromISO(filepathRegex[1], {
					zone: "utc",
				}).toJSDate();
				debug(
					"getMappedDate: using filename regex time for %o of %o: %o",
					this.inputPath,
					filepathRegex[1],
					dateObj,
				);
				return dateObj;
			}

			// No date was specified.
			if (this.isVirtualTemplate()) {
				return new Date();
			}

			return this._getDateInstance("birthtimeMs");
		}
	}

	// Important reminder: Template data is first generated in TemplateMap
	async getTemplateMapEntries(data) {
		debugDev("%o getMapped()", this.inputPath);

		this.behavior.setRenderViaDataCascade(data);

		let entries = [];
		// does not return outputPath or url, we don’t want to render permalinks yet
		entries.push({
			template: this,
			inputPath: this.inputPath,
			data,
		});

		return entries;
	}
}

export default Template;
