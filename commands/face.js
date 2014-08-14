var _ = require('lodash'),
	 async = require('async'),
	fs = require("fs"), 
	path = require("path"),
	UglifyJS = require("uglify-js"),
	sass = require("node-sass"),
	cleanCSS = require("clean-css");

module.exports = {
	name:'face',
	description:'Builds all of the front end assets for each microservice',
	example:'bosco face | bosco face watch',
	cmd:cmd
}

function cmd(bosco, args) {
	
	bosco.log("Compile front end assets across services: " + args);

	var repos = bosco.config.get('github:repos'),
		jsAssets = {},
		cssAssets = {};

	if(!repos) return bosco.error("You are repo-less :( You need to initialise bosco first, try 'bosco fly'.");

	var loadRepo = function(repo, next) {	
		var repoBosco, basePath, repoPath = bosco.getRepoPath(repo), repoBoscoConfig = [repoPath,"bosco-service.json"].join("/");
		if(bosco.exists(repoBoscoConfig)) {
			repoBosco = require(repoBoscoConfig);
			if(repoBosco.assets) {
				basePath = repoBosco.assets.basePath || "";
				process(repoPath + basePath, repoBosco.assets);
				compileJs();
				compileCss();
			}
		}
		next();
	}

	var process = function(repoPath, assets) {
		_.forOwn(assets.js, function(value, key) {
			if(value) {
				value.forEach(function(asset) {
					jsAssets[key] = jsAssets[key] || [];
					jsAssets[key].push([repoPath,asset].join("/"));
				})
			}
		});
		_.forOwn(assets.css, function(value, key) {
			if(value) {
				value.forEach(function(asset) {
					cssAssets[key] = cssAssets[key] || [];
					cssAssets[key].push([repoPath,asset].join("/"));
				})
			}
		})
	}

	var compileJs = function() {
		var compiledJs = {};
		_.forOwn(jsAssets, function(files, key) {
			console.dir(key + ' ' + files)
			compiledJs[key] = UglifyJS.minify(files);
		});
		console.dir(compiledJs);
		// Write to disk or push somewhere with version / md5 hash
	}

	var compileCss = function() {
		var compiledCss = {};
		_.forOwn(cssAssets, function(files, key) {
			compiledCss[key] += _.map(files, function(file){ return fs.readFileSync(file) });
		});
		console.dir(compiledCss);
		// Write to disk or push somewhere with version / md5 hash
	}

	async.mapSeries(repos, loadRepo, function(err) {
		bosco.log("Done " + args);
	})

}