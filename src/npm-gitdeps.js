'use strict';


var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var tar = require('tar');
var shell = require('shelljs');
var Deferred = require('deferreds/Deferred');
var Chainable = require('deferreds/Chainable');

var util = require('./util');


var run = function() {
	var projectDir = process.cwd();
	var pkgFile = path.resolve(projectDir, 'package.json');

	if (!fs.existsSync(pkgFile)) {
		throw 'No package.json found in parent project';
	}

	var pkg = JSON.parse(fs.readFileSync(pkgFile).toString());

	if (!pkg.gitCloneDependencies) {
		return;
	}

	new Chainable(Object.keys(pkg.gitCloneDependencies))
		.map(function gatherMetadata(repo) {
			var treeish = pkg.gitCloneDependencies[repo];
			var name = repo.split('/').pop().trim().replace(/\.git$/, '');
			var dest = path.resolve(projectDir, 'components', name);

			//short-form (user)/(repo) github urls
			if (repo.split('/').length === 2) {
				repo = 'git://github.com/' + repo + '.git';
			}

			return {
				repo: repo,
				treeish: treeish,
				name: name,
				dest: dest
			};
		})
		.filterSeries(function checkUpdates(obj) {
			var dotfile = path.resolve(obj.dest, '.npm-git-clone');
			if (!fs.existsSync(dotfile)) {
				return true;
			}
			var currentVersion = JSON.parse(fs.readFileSync(dotfile)).treeish;
			return util.needsUpdate(currentVersion, obj.treeish, obj.repo);
		})
		.mapSeries(function getArchive(obj) {
			return util.getArchive(obj.repo, obj.treeish).then(function(result) {
				return {
					repo: obj.repo,
					name: obj.name,
					dest: obj.dest,
					treeish: result.treeish,
					tarball: result.tarball
				};
			});
		})
		.mapSeries(function untar(obj) {
			var deferred = new Deferred();
			var out = fs.createReadStream(obj.tarball);

			if (['.gz', '.tgz'].indexOf(path.extname(obj.tarball)) !== -1) {
				out = out.pipe(zlib.createGunzip());
			}

			out
				.pipe(tar.Extract({ path: obj.dest }))
				.on('error', function(err) {
					deferred.reject(err);
				})
				.on('end', function() {
					deferred.resolve(obj);
				});
			return deferred.promise();
		})
		.map(function flatten(obj) {
			var files = shell.ls(obj.dest);
			if (files.length === 1) {
				shell.mv(path.resolve(obj.dest, files[0]) + '/*', obj.dest + '/');
			}
			return obj;
		})
		.map(function storeMetadata(obj) {
			var dotfile = path.resolve(obj.dest, '.npm-git-clone');
			fs.writeFileSync(dotfile, JSON.stringify({
				repo: obj.repo,
				treeish: obj.treeish
			}, false, 4));
			return obj;
		})
		.then(function report(results) {
			results.forEach(function(obj) {
				process.stdout.write(obj.name + '@' + obj.treeish + ' ' + path.relative(projectDir, obj.dest) + '\n');
			});
		}, function(err) {
			if (err.stack) {
				process.stderr.write(err.stack);
			}
			else {
				process.stderr.write(err.toString());
			}
			process.stderr.write('\n\n');
			process.exit(1);
		});

};


module.exports = run;
