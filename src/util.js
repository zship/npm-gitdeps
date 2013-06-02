'use strict';


var fs = require('fs');
var path = require('path');
var https = require('https');
var child = require('child_process');

var temp = require('temp');
var semver = require('semver');
var Deferred = require('deferreds/Deferred');
require('colors');


var PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'))).version;

var _ghHeaders = {
	'user-agent': 'npm-git-clone/' + PKG_VERSION
};

var _cmd = function(command, cwd) {
	cwd = cwd || process.cwd();

	var deferred = new Deferred();

	child.exec(command, {cwd: cwd, maxBuffer: 10000000}, function(err, stdout) {
		if (err) {
			deferred.reject(err);
		}
		else {
			deferred.resolve(stdout);
		}
	});

	return deferred.promise();
};


var util = {};


// Search for a filename in the given directory or all parent directories.
util.findup = function(dirpath, filename) {
	var filepath = path.join(dirpath, filename);
	if (fs.existsSync(filepath)) { return filepath; }
	var parentpath = path.resolve(dirpath, '..');
	return parentpath === dirpath ? null : util.findup(parentpath, filename);
};


util.githubShortName = function(repo) {
	return repo.replace(/.*?github.com\//, '').replace(/\.git$/, '');
};


var _refsGit = function(repo) {
	return _cmd('git ls-remote ' + repo)
		.then(function(data) {
			return data.split('\n').map(function(line) {
				return line.split('\t').pop();
			});
		});
};


var _refsGithub = function(repo) {
	var deferred = new Deferred();
	var repoShortName = util.githubShortName(repo);

	https.get({
		hostname: 'api.github.com',
		path: '/repos/' + repoShortName + '/git/refs',
		headers: _ghHeaders
	}, function(response) {
		var body = '';
		response
			.on('error', function(err) {
				deferred.reject(err);
			})
			.on('data', function(data) {
				body += data;
			})
			.on('end', function() {
				var refs = JSON.parse(body).map(function(obj) {
					return obj.ref;
				});
				deferred.resolve(refs);
			});
	}).on('error', function(e) {
		deferred.reject(e);
	});
	return deferred.promise();
};


var _refCache = {};
util.refs = function(repo) {
	if (_refCache[repo]) {
		return _refCache[repo];
	}

	if (repo.search(/github/) !== -1) {
		_refCache[repo] = _refsGithub(repo);
	}
	else {
		_refCache[repo] = _refsGit(repo);
	}

	return _refCache[repo];
};


util.semverToTag = function(range, refs) {
	var semverMatch = refs
		.map(function(ref) {
			var matches = ref.match(/refs\/tags\/(.*\d+)/);
			if (!matches) {
				return undefined;
			}
			var tag = matches[1];
			matches = tag.match(/(\d+\.\d+\.\d+)/);
			if (!matches) {
				return undefined;
			}
			var version = matches[1];
			return {
				tag: tag,
				version: version
			};
		})
		.sort(function(a, b) {
			return semver.rcompare(a.version, b.version);
		})
		.filter(function(ref) {
			if (ref === undefined) {
				return false;
			}
			return semver.satisfies(ref.version, range);
		})[0];
	return semverMatch;
};


util.needsUpdate = function(current, range, repo) {
	return new Deferred().resolve().then(function() {
		//non-semver versions are tags, branches, or commit shas (and those don't change)
		if (!semver.validRange(range)) {
			return false;
		}
		return util.refs(repo)
			.then(function(refs) {
				return util.semverToTag(range, refs).tag !== current;
			});
	});
};


var _getArchiveGit = function(repo, treeish) {
	var tmpDir = temp.mkdirSync('npm-git-clone');
	var cloneDir = path.resolve(tmpDir, 'repo');

	return util.refs(repo)
		.then(function(refs) {
			var isRef = refs.filter(function(ref) {
				return (
					ref === 'refs/heads/' + treeish ||
					ref === 'refs/tags/' + treeish
				);
			}).length;

			var cloneCmd;
			if (isRef) {
				//we can do a faster shallow copy if a branch or tag was requested
				cloneCmd = 'git clone --depth 1 ' + repo + ' ' + cloneDir;
			}
			else {
				cloneCmd = 'git clone ' + repo + ' ' + cloneDir;
			}
			process.stdout.write('npm-git-clone: ' + 'git clone '.green + repo + '#' + treeish);
			return _cmd(cloneCmd).then(function() {
				return refs;
			});
		})
		.then(function() {
			//git clone does not necessarily fetch tags during a clone (only if
			//they're reachable from current head)
			return _cmd('git show-ref', cloneDir).then(function(data) {
				//is treeish not here? fetch tags.
				var refs = data.split('\n').map(function(line) {
					return line.split(' ').pop();
				});
				if (refs.indexOf('refs/tags/' + treeish) === -1) {
					return _cmd('git fetch --tags', cloneDir);
				}
			});
		})
		.then(function() {
			return _cmd('git archive --format=tar ' + treeish + ' > ../repo.tar', cloneDir);
		})
		.then(function() {
			return path.resolve(tmpDir, 'repo.tar');
		});
};


//we can use the Github API to avoid a full (or possibly shallow) git clone
//when the repo is hosted at Github
var _getArchiveGithub = function(repo, treeish) {
	var tmpDir = temp.mkdirSync('npm-git-clone');

	var deferred = new Deferred();
	var repoShortName = util.githubShortName(repo);
	process.stdout.write('npm-git-clone: ' + 'GET github archive '.green + repoShortName + '#' + treeish);
	https.get({
		hostname: 'api.github.com',
		path: '/repos/' + repoShortName + '/tarball/' + treeish,
		headers: _ghHeaders
	}, function(response) {
		https.get(response.headers.location, function(response) {
			var filename = response.headers['content-disposition'].match(/filename=(.*)/)[1];
			var file = path.resolve(tmpDir, filename);

			var out = fs.createWriteStream(file);
			response.pipe(out);

			response
				.on('error', function(err) {
					deferred.reject(err);
				})
				.on('end', function() {
					deferred.resolve(file);
				});
		}).on('error', function(e) {
			deferred.reject(e);
		});
	}).on('error', function(e) {
		deferred.reject(e);
	});
	return deferred.promise();
};


//generate a .tar archive from a git repo at a tree-ish ref/commit and return
//the path to the archive
util.getArchive = function(repo, treeish) {
	var start = Date.now();
	return util.refs(repo)
		.then(function(refs) {
			if (semver.validRange(treeish)) {
				var semverMatch = util.semverToTag(treeish, refs);
				if (!semverMatch) {
					throw 'No git tags in ' + repo + ' match the semantic version string "' + treeish + '":\n' + JSON.stringify(refs, false, 4);
				}
				treeish = semverMatch.tag;
			}

			if (repo.search(/github/) !== -1) {
				return _getArchiveGithub(repo, treeish);
			}
			else {
				return _getArchiveGit(repo, treeish);
			}
		})
		.then(function(tarball) {
			var end = Date.now();
			var duration = (end - start) / 1000;
			process.stdout.write(' [' + duration.toFixed(1) + 's]\n');
			return {
				tarball: tarball,
				treeish: treeish
			};
		});
};


module.exports = util;
