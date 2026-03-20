const NODE_DEFINITIONS = {
  guardian: {
    label: 'Guardian',
    primary_service_name: 'Guardian API',
    default_port: 4005,
    extra_services: [
      { name: 'Solr', port: 8983, required: true }
    ],
    notes: 'Official Guardian installs expose two services: Guardian on 4005 and Solr on 8983.'
  },
  geocore: {
    label: 'GeoCore',
    primary_service_name: 'ConnectionPort',
    default_port: 4013,
    extra_services: [],
    notes: 'GeoCore uses a single TCP service. Default is 4013, but operators may choose another external port.'
  },
  synaptron: {
    label: 'Synaptron',
    primary_service_name: 'Synaptron runtime',
    default_port: 8000,
    extra_services: [
      { name: 'Neo4j HTTP', port: 7475, required: false },
      { name: 'Neo4j Bolt', port: 7688, required: false }
    ],
    notes: 'Official docs say Synaptron does not require public open ports. Docker installs often expose 8000 plus optional Neo4j ports for local/admin use.'
  },
  collector: {
    label: 'Collector',
    primary_service_name: 'Collector worker',
    default_port: 37566,
    extra_services: [],
    notes: 'Official Collector docs describe it as an outbound worker and do not document a public inbound service port. Keep the port editable if you are monitoring a custom/local endpoint.'
  }
};

function definitionForType(type) {
  return NODE_DEFINITIONS[String(type || '').toLowerCase()] || null;
}

module.exports = {
  NODE_DEFINITIONS,
  definitionForType
};
