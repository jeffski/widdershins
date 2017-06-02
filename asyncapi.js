var up = require('url');
var path = require('path');
var util = require('util');

var common = require('./common.js');

var yaml = require('js-yaml');
var xml = require('jgexml/json2xml.js');
var jptr = require('jgexml/jpath.js');
var recurseotron = require('openapi_optimise/common.js');
var circular = require('openapi_optimise/circular.js');
var sampler = require('openapi-sampler');
var dot = require('dot');
dot.templateSettings.strip = false;
dot.templateSettings.varname = 'data';
var templates;

var circles = [];

/**
* function to reformat asyncapi topics object into an iodocs-style resources object, tags-first
*/
function convertToToc(source) {
	var apiInfo = common.clone(source, false);
	apiInfo.resources = {};
	for (var t in apiInfo.topics) {
		for (var m in apiInfo.topics[t]) {
			var sMessage = apiInfo.topics[t][m];
			var ioMessage = {};
			ioMessage.topic = t;
			ioMessage.message = m;
			var sMessageUniqueName = (m + '_' + t).split('/').join('_');
			sMessageUniqueName = sMessageUniqueName.split(' ').join('_'); // TODO {, } and : ?
			var tagName = 'Default';
			if (sMessage.tags && sMessage.tags.length > 0) {
				tagName = sMessage.tags[0];
			}
			if (!apiInfo.resources[tagName]) {
				apiInfo.resources[tagName] = {};
				if (apiInfo.tags) {
					for (var t in apiInfo.tags) {
						var tag = apiInfo.tags[t];
						if (tag.name == tagName) {
							apiInfo.resources[tagName].description = tag.description;
							apiInfo.resources[tagName].externalDocs = tag.externalDocs;
						}
					}
				}
			}
			if (!apiInfo.resources[tagName].messages) apiInfo.resources[tagName].messages = {};
			apiInfo.resources[tagName].messages[sMessageUniqueName] = ioMessage;
		}
	}
	delete apiInfo.paths; // to keep size down
	delete apiInfo.definitions; // ditto
	delete apiInfo.components; // ditto
	return apiInfo;
}

function convertServers(asyncapi, options) {
	var result = common.clone(asyncapi);
	result.servers = [];
	var u = up.parse(options.loadedFrom ? options.loadedFrom : '/');
	var schemes = asyncapi.schemes || [];
	if (!schemes.length) {
		schemes.push((u.protocol ? u.protocol : 'http').split(':')[0]);
	}
	for (var scheme of schemes) {
		result.servers.push({url:scheme+'://'+(asyncapi.host ? asyncapi.host : (u.host ? u.host : 'example.com'))+(asyncapi.basePath ? asyncapi.basePath : (u.path ? u.path : '/'))});
	}
	return result;
}

function convert(asyncapi, options, callback) {

	var defaults = {};
	defaults.language_tabs = [{ 'javascript': 'JavaScript' }, { 'javascript--nodejs': 'Node.JS' }, { 'python': 'Python' }, { 'ruby': 'Ruby' }, { 'java': 'Java' }, { 'go': 'Go'}];
	defaults.codeSamples = true;
	defaults.theme = 'darkula';
	defaults.search = true;
	defaults.sample = true;
	defaults.discovery = false;
	defaults.includes = [];
	defaults.templateCallback = function (templateName, stage, data) { return data; };

	options = Object.assign({}, defaults, options);
	if (!options.codeSamples) defaults.language_tabs = [];

	if (typeof templates === 'undefined') {
		templates = dot.process({ path: path.join(__dirname, 'templates', 'asyncapi') });
	}
	if (options.user_templates) {
		templates = Object.assign(templates, dot.process({ path: options.user_templates }));
	}

	var header = {};
	header.title = asyncapi.info.title + ' ' + ((asyncapi.info.version && asyncapi.info.version.toLowerCase().startsWith('v')) ? asyncapi.info.version : 'v' + (asyncapi.info.version||'?'));

	// we always show json / yaml / xml if used in consumes/produces
	header.language_tabs = options.language_tabs;

	circles = circular.getCircularRefs(asyncapi, options);

	header.toc_footers = [];
	if (asyncapi.externalDocs) {
		if (asyncapi.externalDocs.url) {
			header.toc_footers.push('<a href="' + asyncapi.externalDocs.url + '">' + (asyncapi.externalDocs.description ? asyncapi.externalDocs.description : 'External Docs') + '</a>');
		}
	}
	header.includes = options.includes;
	header.search = options.search;
	header.highlight_theme = options.theme;

	asyncapi = convertServers(asyncapi, options);

	var data = {};
	data.api = data.openapi = asyncapi;
	data.baseTopic = asyncapi.baseTopic;
	data.header = header;

	var content = '';

	if (asyncapi.servers && asyncapi.servers.length) {
		data.servers = asyncapi.servers;
	}
	else if (options.loadedFrom) {
		data.servers = [{url:options.loadedFrom}];
	}
	else {
		data.servers = [{url:'//'}];
	}

	data.contactName = (asyncapi.info.contact && asyncapi.info.contact.name ? asyncapi.info.contact.name : 'Support');

	data = options.templateCallback('heading_main', 'pre', data);
	if (data.append) { content += data.append; delete data.append; }
	content += templates.heading_main(data) + '\n';
	data = options.templateCallback('heading_main', 'post', data);
	if (data.append) { content += data.append; delete data.append; }

	var apiInfo = convertToToc(asyncapi);

	for (var r in apiInfo.resources) {
		content += '# ' + r + '\n\n';
		var resource = apiInfo.resources[r]
		if (resource.description) content += resource.description + '\n\n';

		if (resource.externalDocs) {
			if (resource.externalDocs.url) {
				content += '<a href="' + resource.externalDocs.url + '">' + (resource.externalDocs.description ? resource.externalDocs.description : 'External docs') + '</a>\n';
			}
		}

		for (var m in resource.messages) {
			var message = resource.messages[m];
			var subtitle = message.message + ' ' + asyncapi.baseTopic + '.' + message.topic;
			var msg = asyncapi.topics[message.topic][message.message];
			if (!message.message.startsWith('x-')) {

				var opName = subtitle;
				content += '## ' + opName + '\n\n';

				var topic = data.baseTopic + '.' + message.topic;

				data.message = data.method = message.message;
				data.topic = topic;
				data.operation = message;
				data.tags = asyncapi.topics[message.topic][message.message].tags;
				data.security = asyncapi.topics[message.topic][message.message].security;
				data.resource = resource;
				data.allHeaders = []; // TODO remove me
				data.headerParameters = [];
				data.consumes = [];
				data.produces = [];

				if (msg.$ref) {
					msg = common.dereference(msg, circles, asyncapi);
				}

				data.payload = {};
				var obj = data.payload.obj = common.dereference(msg.payload, circles, asyncapi);

				var xmlWrap = '';
				if (obj && obj.xml && obj.xml.name) {
					xmlWrap = obj.xml.name;
				}
				if (Object.keys(obj).length > 0) {
					data = options.templateCallback('heading_example_payloads', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.heading_example_payloads(data) + '\n';
					data = options.templateCallback('heading_example_payloads', 'post', data);
					if (data.append) { content += data.append; delete data.append; }

					if (options.sample) {
						try {
							obj = sampler.sample(obj); // skipReadOnly: false
						}
						catch (ex) {
							console.log('# ' + ex);
						}
					}
					content += '```json\n';
					content += JSON.stringify(obj, null, 2) + '\n';
					content += '```\n';
					if (xmlWrap) {
						var newObj = {};
						newObj[xmlWrap] = obj;
						obj = newObj;
					}
					if ((typeof obj === 'object') && xmlWrap) {
						content += '```xml\n';
						content += xml.getXml(obj, '@', '', true, '  ', false) + '\n';
						content += '```\n';
					}
				}

				data.payload.obj = obj;
				data.payload.str = util.inspect(data.payload.obj);
				data.payload.json = JSON.stringify(data.payload.obj, null, 2);

				var codeSamples = (options.codeSamples || msg["x-code-samples"]);
				if (codeSamples) {
					data = options.templateCallback('heading_code_samples', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.heading_code_samples(data);
					data = options.templateCallback('heading_code_samples', 'post', data);
					if (data.append) { content += data.append; delete data.append; }

					if (msg["x-code-samples"]) {
						for (var s in msg["x-code-samples"]) {
							var sample = msg["x-code-samples"][s];
							var lang = common.languageCheck(sample.lang, header.language_tabs, true);
							content += '```' + lang + '\n';
							content += sample.source;
							content += '\n```\n';
						}
					}
					else {
						if (common.languageCheck('javascript', header.language_tabs, false)) {
							content += '```javascript\n';
							data = options.templateCallback('code_javascript', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_javascript(data);
							data = options.templateCallback('code_javascript', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('javascript--nodejs', header.language_tabs, false)) {
							content += '```javascript--nodejs\n';
							data = options.templateCallback('code_nodejs', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_nodejs(data);
							data = options.templateCallback('code_nodejs', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('ruby', header.language_tabs, false)) {
							content += '```ruby\n';
							data = options.templateCallback('code_ruby', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_ruby(data);
							data = options.templateCallback('code_ruby', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('python', header.language_tabs, false)) {
							content += '```python\n';
							data = options.templateCallback('code_python', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_python(data);
							data = options.templateCallback('code_python', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('java', header.language_tabs, false)) {
							content += '```java\n';
							data = options.templateCallback('code_java', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_java(data);
							data = options.templateCallback('code_java', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('go', header.language_tabs, false)) {
							content += '```go\n';
							data = options.templateCallback('code_go', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_go(data);
							data = options.templateCallback('code_go', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
					}
				}

				if (subtitle != opName) content += '`' + subtitle + '`\n\n';

				if (msg.summary) content += '*' + msg.summary + '*\n\n';
				if (msg.description) content += msg.description + '\n\n';

				var security = (msg.security ? msg.security : asyncapi.security);
				if (!security) security = [];
				if (security.length <= 0) {
					data = options.templateCallback('authentication_none', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.authentication_none(data);
					data = options.templateCallback('authentication_none', 'post', data);
					if (data.append) { content += data.append; delete data.append; }
				}

				content += '\n';

			}
		}
	}

	data = options.templateCallback('footer', 'pre', data);
	if (data.append) { content += data.append; delete data.append; }
	content += templates.footer(data) + '\n';
	data = options.templateCallback('footer', 'post', data);
	if (data.append) { content += data.append; delete data.append; }

	if (options.discovery) {
		data = options.templateCallback('discovery', 'pre', data);
		if (data.append) { content += data.append; delete data.append; }
		content += templates.discovery(data) + '\n';
		data = options.templateCallback('discovery', 'post', data);
		if (data.append) { content += data.append; delete data.append; }
	}

	var headerStr = '---\n' + yaml.safeDump(header) + '---\n';
	// apparently you can insert jekyll front-matter in here for github -- see lord/slate
	var result = (headerStr + '\n' + content.split('\n\n\n').join('\n\n'));
	if (callback) callback(null, result);
	return result;
}

module.exports = {
	convert: convert
};