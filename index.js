/**
 * Core bosco libraries
 */

var _ = require('lodash');
var async = require('async');
var events = require('events');
var fs = require('fs');
var knox = require('knox');
var mkdirp = require('mkdirp');
var path = require('path');
var progress = require('progress');
var prompt = require('prompt');
var request = require('request');
var semver = require('semver');
var sf = require('sf');
var Table = require('cli-table');
var util = require('util');

prompt.message = 'Bosco'.green;

function Bosco() {}
util.inherits(Bosco, events.EventEmitter);
module.exports = Bosco;

Bosco.prototype.init = function(options) {

    var self = this;

    self._defaults = {
        _defaultConfig: [__dirname, 'config/bosco.json'].join('/')
    };

    self.options = _.defaults(_.clone(options), self._defaults);

    self.options.configPath = options.configPath ? path.resolve(options.configPath) : [self.findWorkspace(), '.bosco'].join('/');
    self.options.workspace = options.configPath ? path.resolve('..') : path.resolve(self.options.configPath, '..');
    self.options.configFile = options.configFile ? path.resolve(options.configFile) : [self.options.configPath, 'bosco.json'].join('/');

    self.options.envConfigFile = [self.options.configPath, self.options.environment + '.json'].join('/');
    self.options.defaultsConfigFile = [self.options.configPath, 'defaults.json'].join('/');
    self.options.cpus = require('os').cpus().length;
    self.options.inService = false;

    self.config = require('nconf');
    self.prompt = prompt;
    self.progress = progress;

    events.EventEmitter.call(this);

    self.run();

}

Bosco.prototype.run = function() {

    var self = this;

    self._init(function(err) {

        self._checkVersion();

        if (err) { return console.log(err); }

        var quotes, quotePath = self.config.get('quotes') || './quotes.json';
        try {
            quotes = require(quotePath);
        } catch (ex) {
            console.log('Failed to load quotes: ' + quotePath);
        }
        if (quotes) {
            self.log(quotes[Math.floor(Math.random() * quotes.length)].blue);
        }

        var aws = self.config.get('aws');
        if (aws && aws.key) {
            self.knox = knox.createClient({
                key: aws.key,
                secret: aws.secret,
                bucket: aws.bucket,
                region: aws.region
            });
        }

        self.staticUtils = require('./src/StaticUtils')(self);

        self.checkInService();

        self.log('Initialised using [' + self.options.configFile.magenta + '] in environment [' + self.options.environment.green + ']');
        self._cmd();

    });
}

Bosco.prototype._init = function(next) {

    var self = this;

    var loadConfig = function() {
        self.config.env()
            .file({
                file: self.options.configFile
            })
            .file('environment', {
                file: self.options.envConfigFile
            })
            .file('defaults', {
                file: self.options.defaultsConfigFile
            });
    }

    self._checkConfig(function(err, initialise) {

        if (err) return;

        loadConfig();

        // Check for issue #12
        if (self._checkRepoPath()) {
            return self._moveRepoPath(function(err) {
                if (err) return self.error(err.message);
                self.log('Folders all moved - please check the old organization folder and delete manually, once you have done this you can use Bosco normally.');
            });
        }

        if (initialise) {
            self._initialiseConfig(function(err) {
                if (err) return;
                next();
            });
        } else {
            if (!self.config.get('github:organization')) {
                self.error('It looks like you are in a micro service folder or something is wrong with your config?\n');
                next('error');
            } else {
                next();
            }
        }

    });

}

Bosco.prototype._checkConfig = function(next) {

    var self = this,
        defaultConfig = self.options._defaultConfig,
        configPath = self.options.configPath,
        configFile = self.options.configFile;

    var checkConfigPath = function(cb) {
        if (!self.exists(configPath)) {
            mkdirp(configPath, cb);
        } else {
            cb();
        }
    }

    var checkConfig = function(cb) {
        if (!self.exists(configFile)) {
            prompt.start();
            prompt.get({
                properties: {
                    confirm: {
                        description: 'Do you want to create a new configuration file in the current folder (y/N)?'.white
                    }
                }
            }, function(err, result) {
                if (!result) return cb({
                    message: 'Did not confirm'
                });
                if (result.confirm == 'Y' || result.confirm == 'y') {
                    var content = fs.readFileSync(defaultConfig);
                    fs.writeFileSync(configFile, content);
                    cb(null, true);
                } else {
                    cb({
                        message: 'Did not confirm'
                    });
                }
            });
        } else {
            cb();
        }
    }

    async.series([checkConfigPath, checkConfig], function(err, result) {
        next(err, result[1]);
    });

}

Bosco.prototype._initialiseConfig = function(next) {

    var self = this;
    prompt.start();

    prompt.get({
        properties: {
            githubUser: {
                description: 'Enter your github user name:'.white
            },
            github: {
                description: 'Enter the name of the github organization you want to use:'.white
            },
            auth: {
                description: 'Enter the auth token (see: https://github.com/blog/1509-personal-api-tokens):'.white
            },
            team: {
                description: 'Enter the team name that will be used to filter the repository list (optional - defaults to Owners):'.white
            }
        }
    }, function(err, result) {
        self.config.set('github:user', result.githubUser);
        self.config.set('github:organization', result.github);
        self.config.set('github:authToken', result.auth);
        self.config.set('github:team', result.team || 'Owners');
        self.config.set('github:ignoredRepos', []);
        console.log('\r');
        self.config.save(next);
    });
};

Bosco.prototype._cmd = function() {

    var self = this,
        commands = self.options.args,
        command = commands.shift(),
        commandModule = [self.getGlobalCommandFolder(), command, '.js'].join(''),
        localCommandModule = [self.getLocalCommandFolder(), command, '.js'].join('');

    if (self.exists(commandModule)) {
        require(commandModule).cmd(self, commands);
    } else {
        if (self.exists(localCommandModule)) {
            require(localCommandModule).cmd(self, commands);
        } else {
            if (self.options.shellCommands) {
                self._shellCommands();
            } else {
                self._commands();
            }

        }
    }
}

Bosco.prototype._shellCommands = function() {

    var self = this,
        cmdPath = self.getGlobalCommandFolder(),
        localPath =  self.getLocalCommandFolder();

    var showCommands = function(cPath, files, next) {
        var cmdString = '';
        files.forEach(function(file) {
            cmdString += file.replace('.js', '') + ' ';
        });
        next(null, cmdString.split(' '));
    }

    async.series([

            function(next) {
                fs.readdir(cmdPath, function(err, files) {
                    showCommands(cmdPath, files, next)
                })
            },
            function(next) {
                fs.readdir(localPath, function(err, files) {
                    if (!files || files.length === 0) return next();
                    showCommands(localPath, files, next)
                })
            }
        ],
        function(err, files) {
            files = _.uniq(_.flatten(files));
            console.log('Available commands: ' + files.join(' '));
            process.exit(0);
        });
}

Bosco.prototype._commands = function() {

    var self = this,
        cmdPath = self.getGlobalCommandFolder(),
        localPath =  self.getLocalCommandFolder();

    var showTable = function(tableName, cPath, files, next) {

        var table = new Table({
            chars: {'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': ''},
            head: [tableName, 'Example'],
            colWidths: [12, 80]
        });

        var showCommand = function(cmd) {
            table.push([cmd.name, cmd.example || '']);
        }

        files.map(function(file) {
            return path.join(cPath, file);
        }).filter(function(file) {
            return fs.statSync(file).isFile();
        }).forEach(function(file) {
            if (path.extname(file) !== '.js') { return null; }
            showCommand(require(file))
        });
        console.log(table.toString());
        console.log('\r');
        next();
    }

    console.log('\r');
    self.warn('Hey, to use bosco, you need to enter one of the following commands:')

    async.series([

            function(next) {
                fs.readdir(cmdPath, function(err, files) {
                    showTable('Core', cmdPath, files, next)
                })
            },
            function(next) {
                fs.readdir(localPath, function(err, files) {
                    if (!files || files.length === 0) return next();
                    showTable('Local', localPath, files, next)
                })
            },
            function(next) {
                var wait = function() {
                    if (self._checkingVersion) {
                        setTimeout(wait, 100);
                    } else {
                        next();
                    }
                }
                wait();
            },
            function(next) {
                console.log('You can also specify these parameters:')
                console.log(self.options.program.help());
                next();
            }
        ],
        function() {
            // Do nothing
        });


}

Bosco.prototype._checkVersion = function() {
    // Check the version in the background
    var self = this;
    self._checkingVersion = true;
    var npmUrl = 'http://registry.npmjs.org/bosco';
    request({
        url: npmUrl,
        timeout: 1000
    }, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var jsonBody = JSON.parse(body);
            var version = jsonBody['dist-tags'].latest;
            if (semver.lt(self.options.version, version)) {
                self.error('There is a newer version (Local: ' + self.options.version.yellow + ' < Remote: ' + version.green + ') of Bosco available, you should upgrade!');
                console.log('\r');
            }
        }
        self._checkingVersion = false;
    });
}


Bosco.prototype._checkRepoPath = function() {
    // This is a check for the move from the repos being in a path with the organization
    // to just being in the working folder
    var self = this;

    // Do we have any repos
    if (!self.config.get('github:repos')) return false;

    // Check the first repo
    return self.exists(self.getOldRepoPath(self.config.get('github:repos')[0]));
}

Bosco.prototype._moveRepoPath = function(next) {
    var self = this;
    prompt.start();
    prompt.get({
        properties: {
            confirm: {
                description: 'I need to move your repositories from the old organisation path to this folder, can I proceed [y/N]?'.white
            }
        }
    }, function(err, result) {
        if (!result) return next({
            message: 'Did not confirm'
        });
        if (result.confirm == 'Y' || result.confirm == 'y') {
            self.log('Moving repositories - this may take some time ...');
            var repos = self.config.get('github:repos');
            async.map(repos, function(repo, cb) {
                fs.rename(self.getOldRepoPath(repo), self.getRepoPath(repo), cb)
            }, next);
        } else {
            next({
                message: 'Did not confirm'
            });
        }
    });
}

Bosco.prototype.findWorkspace = function() {
    for (var p = path.resolve('.');; p = path.resolve(p, '..')) {
        if (this.exists(path.join(p, '.bosco', 'bosco.json'))) return p;
        if (p === '/') break;
    }
    return path.resolve('.');
}

Bosco.prototype.getWorkspacePath = function() {
    var self = this;
    return self.options.workspace;
}

Bosco.prototype.getOrg = function() {
    return this.config.get('github:organization');
}

Bosco.prototype.getOrgPath = function() {
    return path.resolve(this.getWorkspacePath());
}

Bosco.prototype.getRepoPath = function(repo) {
    // Strip out / to support full github references
    var repoName;
    if (repo.indexOf('/') < 0) {
        repoName = repo;
    } else {
        repoName = repo.split('/')[1];
    }
    return [path.resolve(this.getWorkspacePath()), repoName].join('/');
}

// To support change outlined in issue #12
Bosco.prototype.getOldOrgPath = function() {
    return [path.resolve(this.getWorkspacePath()), this.getOrg()].join('/');
}

Bosco.prototype.getOldRepoPath = function(repo) {
    return [this.getOldOrgPath(), repo].join('/');
}

// Additional exports
Bosco.prototype.getGlobalCommandFolder = function() {
    return [__dirname, '/', 'commands', '/'].join('');
}

Bosco.prototype.getLocalCommandFolder = function() {
    var self = this,
        workspace = self.options && self.options.workspace ?self.options.workspace : self.findWorkspace();
    return [workspace, '/', 'commands', '/'].join('');
}

Bosco.prototype.getRepoUrl = function(repo) {
    var org;
    if (repo.indexOf('/') < 0) {
        org = this.getOrg() + '/';
    }
    return ['git@github.com:', org ? org : '', repo, '.git'].join('');
}

Bosco.prototype.isLocalCdn = function () {
    return !this.config.get('aws:cdn');
};

Bosco.prototype.getCdnUrl = function () {
    if (!this.isLocalCdn()) {
        return this.config.get('aws:cdn');
    }

    var cdnPort = this.config.get('cdn:port') || '7334';
    var cdnHostname = this.config.get('cdn:hostname') || 'localhost';

    return 'http://'+ cdnHostname +':' + cdnPort;
};

Bosco.prototype.getBaseCdnUrl = function () {
    var baseUrl = this.getCdnUrl();

    if (baseUrl.substr(-1) === '/') {
        baseUrl = baseUrl.substr(0, baseUrl.length - 1);
    }

    if (!this.isLocalCdn()) {
        baseUrl += '/' + this.options.environment;
    }

    return baseUrl;
}

Bosco.prototype.getAssetCdnUrl = function (assetUrl) {
    var baseUrl = this.getBaseCdnUrl();

    if (assetUrl.substr(0, 1) === '/') {
        assetUrl = assetUrl.substr(1);
    }

    return baseUrl + '/' + assetUrl;
}

Bosco.prototype.checkInService = function() {
    var self = this, cwd = path.resolve('bosco-service.json');
    if(self.exists(cwd) && self.options.service) {
        self.options.inService = true;
        self.config.set('github:repos', [path.relative('..','.')]);
    }
}

Bosco.prototype.warn = function(msg, args) {
    this._log('Bosco'.yellow, msg, args);
}

Bosco.prototype.log = function(msg, args) {
    this._log('Bosco'.cyan, msg, args);
}

Bosco.prototype.error = function(msg, args) {
    this._log('Bosco'.red, msg, args);
}

Bosco.prototype._log = function(identifier, msg, args) {
    var parts = {
        identifier: identifier,
        time: new Date(),
        message: args ? sf(msg, args) : msg
    };
    console.log(sf('[{time:hh:mm:ss}] {identifier}: {message}', parts));
}

Bosco.prototype.exists = function(path) {
    return fs.existsSync(path);
}
