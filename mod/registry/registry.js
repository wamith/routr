/**
 * @author Pedro Sanders
 * @since v1
 */
const getConfig = require('@routr/core/config_util')
const {
    Status
} = require('@routr/core/status')
const moment = require('moment')

const SipFactory = Java.type('javax.sip.SipFactory')
const SipUtils = Java.type('gov.nist.javax.sip.Utils')
const Request = Java.type('javax.sip.message.Request')
const InetAddress = Java.type('java.net.InetAddress')
const Caffeine = Java.type('com.github.benmanes.caffeine.cache.Caffeine')
const TimeUnit = Java.type('java.util.concurrent.TimeUnit')
const LogManager = Java.type('org.apache.logging.log4j.LogManager')

const LOG = LogManager.getLogger()
var cseq = 0

class Registry {

    constructor(sipProvider, dataAPIs) {
        this.gatewaysAPI = dataAPIs.GatewaysAPI
        this.checkExpiresTime = 1
        this.sipProvider = sipProvider
        this.config = getConfig()
        this.messageFactory = SipFactory.getInstance().createMessageFactory()
        this.headerFactory = SipFactory.getInstance().createHeaderFactory()
        this.addressFactory = SipFactory.getInstance().createAddressFactory()
        this.userAgent = new java.util.ArrayList()
        this.userAgent.add(this.config.metadata.userAgent)
        this.registry = Caffeine.newBuilder()
            .expireAfterWrite(this.checkExpiresTime, TimeUnit.MINUTES)
            .build()
    }

    getLPAddress(transport, received, rport) {
        try {
            const lp = this.sipProvider.getListeningPoint(transport)
            const host = this.config.spec.externAddr ? this.config.spec.externAddr : lp.getIPAddress()
            const port = rport ? rport : lp.getPort()
            return received ? {
                host: received,
                port: port
            } : {
                host: host,
                port: port
            }
        } catch (e) {
            LOG.error("Transport '" + transport + "' not found in configs => .spec.transport.[*]")
            return
        }
    }

    requestChallenge(username, gwRef, gwHost, transport, received, rport, expires) {
        const contactAddr = this.getLPAddress(transport, received, rport)
        const viaAddr = this.getLPAddress(transport)
        const request = this.messageFactory.createRequest('REGISTER sip:' + gwHost + ' SIP/2.0\r\n\r\n')
        const fromAddress = this.addressFactory.createAddress('sip:' + username + '@' + gwHost)
        const contactAddress = this.addressFactory.createAddress('sip:' + username + '@' + contactAddr.host + ':' + contactAddr.port)
        const contactHeader = this.headerFactory.createContactHeader(contactAddress)
        contactHeader.setParameter('bnc', '')
        const viaHeader = this.headerFactory.createViaHeader(viaAddr.host, viaAddr.port, transport, null)
        viaHeader.setRPort()

        const headers = []

        headers.push(viaHeader)
        headers.push(this.sipProvider.getNewCallId())
        headers.push(this.headerFactory.createProxyRequireHeader('gin'))
        headers.push(this.headerFactory.createRequireHeader('gin'))
        headers.push(this.headerFactory.createExpiresHeader(expires))
        headers.push(this.headerFactory.createMaxForwardsHeader(70))
        headers.push(this.headerFactory.createCSeqHeader(cseq++, Request.REGISTER))
        headers.push(this.headerFactory.createFromHeader(fromAddress, new SipUtils().generateTag()))
        headers.push(this.headerFactory.createToHeader(fromAddress, null))
        headers.push(contactHeader)
        headers.push(this.headerFactory.createUserAgentHeader(this.userAgent))
        headers.push(this.headerFactory.createAllowHeader('INVITE'))
        headers.push(this.headerFactory.createAllowHeader('ACK'))
        headers.push(this.headerFactory.createAllowHeader('BYE'))
        headers.push(this.headerFactory.createAllowHeader('CANCEL'))
        headers.push(this.headerFactory.createAllowHeader('REGISTER'))
        headers.push(this.headerFactory.createAllowHeader('OPTIONS'))
        headers.push(this.headerFactory.createSupportedHeader('path'))
        headers.push(this.headerFactory.createHeader('X-Gateway-Ref', gwRef))
        headers.forEach(header => request.addHeader(header))
        this.sendRequest(request, gwHost)
    }

    sendRequest(request, gwHost) {
        try {
            const clientTransaction = this.sipProvider.getNewClientTransaction(request)
            clientTransaction.sendRequest()
        } catch (e) {
            this.handleChallengeException(e, gwHost)
        }
        LOG.debug(request)
    }

    handleChallengeException(e, gwHost) {
        this.registry.invalidate(gwHost)
        if (e instanceof Java.type('javax.sip.TransactionUnavailableException') ||
            e instanceof Java.type('javax.sip.SipException')) {
            LOG.warn('Unable to register with Gateway -> ' + gwHost + '. (Verify your network status)')
        } else {
            LOG.warn(e)
        }
    }

    storeRegistry(gwURI, expires) {
        // Re-register before actual time expiration
        let actualExpires = expires - 2 * 60 * this.checkExpiresTime

        const reg = {
            username: gwURI.getUser(),
            host: gwURI.getHost(),
            ip: InetAddress.getByName(gwURI.getHost()).getHostAddress(),
            expires: actualExpires,
            registeredOn: Date.now(),
            regOnFormatted: moment(new Date(Date.now())).fromNow()
        }

        this.registry.put(gwURI.toString(), reg)
    }

    removeRegistry(gwURIStr) {
        this.registry.invalidate(gwURIStr)
    }

    listAsJSON() {
        const s = []
        const iterator = this.registry.asMap().values().iterator()

        while (iterator.hasNext()) {
            const reg = iterator.next()
            s.push(reg)
        }

        return s
    }

    isExpired(gwURIStr) {
        const reg = this.registry.getIfPresent(gwURIStr)

        if (reg === null) {
            return true
        }

        const elapsed = (Date.now() - reg.registeredOn) / 1000
        return reg.expires - elapsed <= 0
    }

    start() {
        LOG.info('Starting Registry service')
        const self = this

        global.timer.schedule(
            () => {
                const response = self.gatewaysAPI.getGateways()

                if (response.status === Status.OK) {
                    for (const cnt in response.result) {
                        const gateway = response.result[cnt]

                        if (gateway.spec.credentials === undefined) continue

                        const gwURIStr = 'sip:' + gateway.spec.credentials.username + '@' + gateway.spec.host
                        const expires = gateway.spec.expires ? gateway.spec.expires : 3600
                        if (self.isExpired(gwURIStr)) {
                            LOG.debug('Register with ' + gateway.metadata.name + ' using ' +
                                gateway.spec.credentials.username + '@' + gateway.spec.host)
                            self.requestChallenge(gateway.spec.credentials.username,
                                gateway.metadata.ref, gateway.spec.host, gateway.spec.transport, null, null, expires)
                        }

                        let registries = gateway.spec.registries

                        if (registries !== undefined) {
                            registries.forEach(function(h) {
                                if (self.isExpired(gwURIStr)) {
                                    LOG.debug('Register with ' + gateway.metadata.name + ' using ' + gateway.spec.credentials.username + '@' + h)
                                    self.requestChallenge(gateway.spec.credentials.username, gateway.metadata.ref, h, gateway.spec.transport, null, null, expires)
                                }
                            })
                        }
                    }
                }
            },
            10000,
            this.checkExpiresTime * 60 * 1000
        )
    }

    stop() {
        // ??
    }
}

module.exports = Registry
