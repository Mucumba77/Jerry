package de.mucumba.jerry.testenv;

import de.mucumba.jerry.instrumentation.JerryHttpInterceptor;
import de.mucumba.jerry.instrumentation.JerryMonitor;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicInteger;
import javax.jms.ConnectionFactory;
import javax.management.ObjectName;
import javax.persistence.EntityManager;
import javax.persistence.EntityManagerFactory;
import javax.servlet.*;
import javax.servlet.http.*;
import javax.sql.DataSource;
import org.apache.activemq.ActiveMQConnectionFactory;
import org.apache.activemq.broker.BrokerService;
import org.h2.jdbcx.JdbcDataSource;
import org.quartz.*;
import org.quartz.impl.StdSchedulerFactory;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.jms.listener.DefaultMessageListenerContainer;
import org.springframework.orm.hibernate5.LocalSessionFactoryBean;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.context.support.GenericWebApplicationContext;

/** Isolated fixture; its embedded in-memory JMS broker exists only in the test environment. */
public final class FrameworkFixture extends HttpServlet implements ServletContextListener {
  private static final AtomicInteger jobs = new AtomicInteger(), lazy = new AtomicInteger();
  private static final AtomicInteger secretReads = new AtomicInteger();
  private static EntityManagerFactory entityManagerFactory;
  private ObjectName healthName;
  private ObjectName sharedName;

  public interface HealthMBean {
    int getJobs();

    String getLabel();

    String getPassword();

    String getApi_key();

    String getPrivate_Key();
  }

  public static final class Health implements HealthMBean {
    public int getJobs() {
      return jobs.get();
    }

    public String getLabel() {
      return "Jerry fixture health";
    }

    public String getPassword() {
      secretReads.incrementAndGet();
      return "must-never-be-read";
    }

    public String getApi_key() {
      secretReads.incrementAndGet();
      return "must-never-be-read";
    }

    public String getPrivate_Key() {
      secretReads.incrementAndGet();
      return "must-never-be-read";
    }
  }

  private GenericWebApplicationContext application;
  private Scheduler scheduler;
  private ThreadPoolTaskExecutor executor;
  private static DataSource monitoredDatabase;
  private static ConnectionFactory monitoredJms;
  private BrokerService broker;

  public static final class LazyBean {
    public LazyBean() {
      lazy.incrementAndGet();
    }
  }

  public static final class TestJob implements Job {
    @Override
    public void execute(JobExecutionContext context) throws JobExecutionException {
      if (jobs.incrementAndGet() % 5 == 0)
        throw new JobExecutionException("Expected fixture failure");
    }
  }

  @Override
  public void contextInitialized(ServletContextEvent event) {
    try {
      application = new GenericWebApplicationContext();
      application.setServletContext(event.getServletContext());
      RootBeanDefinition lazyDefinition = new RootBeanDefinition(LazyBean.class);
      lazyDefinition.setLazyInit(true);
      application.registerBeanDefinition("mustRemainLazy", lazyDefinition);
      JdbcDataSource database = new JdbcDataSource();
      database.setURL("jdbc:h2:mem:JerryOrm;DB_CLOSE_DELAY=-1");
      database.setUser("sa");
      database.setPassword("");
      monitoredDatabase = JerryMonitor.dataSource(event.getServletContext(), database);
      broker = new BrokerService();
      broker.setBrokerName("jerry-fixture");
      broker.setPersistent(false);
      broker.setUseJmx(false);
      broker.start();
      broker.waitUntilStarted();
      monitoredJms =
          JerryMonitor.connectionFactory(
              event.getServletContext(),
              new ActiveMQConnectionFactory("vm://jerry-fixture?create=false"));
      Properties hibernate = new Properties();
      hibernate.setProperty("hibernate.dialect", "org.hibernate.dialect.H2Dialect");
      hibernate.setProperty("hibernate.generate_statistics", "true");
      hibernate.setProperty("hibernate.session.events.log", "false");
      RootBeanDefinition jpa = new RootBeanDefinition(LocalContainerEntityManagerFactoryBean.class);
      jpa.getPropertyValues()
          .add("dataSource", database)
          .add("persistenceUnitName", "JerryJpa")
          .add("jpaVendorAdapter", new HibernateJpaVendorAdapter())
          .add("jpaProperties", hibernate);
      application.registerBeanDefinition("fixtureJpa", jpa);
      Properties disabled = new Properties();
      disabled.putAll(hibernate);
      disabled.setProperty("hibernate.generate_statistics", "false");
      RootBeanDefinition nativeFactory = new RootBeanDefinition(LocalSessionFactoryBean.class);
      nativeFactory
          .getPropertyValues()
          .add("dataSource", database)
          .add("hibernateProperties", disabled);
      application.registerBeanDefinition("fixtureHibernateDisabled", nativeFactory);
      executor = new ThreadPoolTaskExecutor();
      executor.setCorePoolSize(1);
      executor.setMaxPoolSize(3);
      executor.setQueueCapacity(8);
      executor.initialize();
      application.getBeanFactory().registerSingleton("fixtureExecutor", executor);
      DefaultMessageListenerContainer listener = new DefaultMessageListenerContainer();
      listener.setDestinationName("jerry.fixture.client-only");
      listener.setConcurrentConsumers(2);
      listener.setMaxConcurrentConsumers(4);
      listener.setAutoStartup(false);
      application.getBeanFactory().registerSingleton("fixtureJmsClient", listener);
      Properties properties = new Properties();
      properties.setProperty("org.quartz.scheduler.instanceName", "JerryFixtureScheduler");
      properties.setProperty("org.quartz.scheduler.makeSchedulerThreadDaemon", "true");
      properties.setProperty("org.quartz.threadPool.class", "org.quartz.simpl.SimpleThreadPool");
      properties.setProperty("org.quartz.threadPool.threadCount", "1");
      properties.setProperty("org.quartz.threadPool.makeThreadsDaemons", "true");
      properties.setProperty("org.quartz.jobStore.class", "org.quartz.simpl.RAMJobStore");
      scheduler = new StdSchedulerFactory(properties).getScheduler();
      application.getBeanFactory().registerSingleton("fixtureQuartz", scheduler);
      application.refresh();
      entityManagerFactory = application.getBean("fixtureJpa", EntityManagerFactory.class);
      healthName = new ObjectName("de.mucumba.jerry.fixture:type=Health");
      ManagementFactory.getPlatformMBeanServer().registerMBean(new Health(), healthName);
      sharedName =
          new ObjectName("de.mucumba.jerry.fixture.shared:application=framework,type=SharedHealth");
      javax.management.modelmbean.ModelMBeanInfoSupport sharedInfo =
          new javax.management.modelmbean.ModelMBeanInfoSupport(
              Health.class.getName(), "Shared model MBean", null, null, null, null);
      ManagementFactory.getPlatformMBeanServer()
          .registerMBean(
              new javax.management.modelmbean.RequiredModelMBean(sharedInfo), sharedName);
      event
          .getServletContext()
          .setAttribute(WebApplicationContext.ROOT_WEB_APPLICATION_CONTEXT_ATTRIBUTE, application);
      scheduler.scheduleJob(
          JobBuilder.newJob(TestJob.class).withIdentity("heartbeat").build(),
          TriggerBuilder.newTrigger()
              .withIdentity("heartbeat-trigger")
              .withSchedule(
                  SimpleScheduleBuilder.simpleSchedule().withIntervalInSeconds(1).repeatForever())
              .build());
      scheduler.start();
    } catch (Exception exception) {
      throw new IllegalStateException(exception);
    }
  }

  @Override
  public void contextDestroyed(ServletContextEvent event) {
    try {
      if (healthName != null)
        ManagementFactory.getPlatformMBeanServer().unregisterMBean(healthName);
    } catch (Exception ignored) {
    }
    try {
      if (sharedName != null)
        ManagementFactory.getPlatformMBeanServer().unregisterMBean(sharedName);
    } catch (Exception ignored) {
    }
    try {
      if (scheduler != null) scheduler.shutdown(true);
    } catch (SchedulerException ignored) {
    }
    try {
      if (broker != null) broker.stop();
    } catch (Exception ignored) {
    }
    if (executor != null) executor.shutdown();
    if (application != null) application.close();
  }

  @Override
  protected void doGet(HttpServletRequest request, HttpServletResponse response)
      throws IOException {
    EntityManager manager = entityManagerFactory.createEntityManager();
    try {
      manager.createNativeQuery("SELECT 1").getSingleResult();
    } finally {
      manager.close();
    }
    response.setContentType("application/json;charset=UTF-8");
    if ("error".equals(request.getParameter("action"))) response.setStatus(500);
    if ("instrument".equals(request.getParameter("action")))
      try {
        try (java.sql.Connection c = monitoredDatabase.getConnection();
            java.sql.Statement s = c.createStatement()) {
          try (java.sql.ResultSet result = s.executeQuery("SELECT 1")) {
            result.next();
          }
          try {
            s.executeQuery("SELECT * FROM JERRY_MISSING_TEST_TABLE");
          } catch (java.sql.SQLException expected) {
          }
        }
        javax.jms.Connection connection = monitoredJms.createConnection();
        try {
          connection.start();
          javax.jms.Session session =
              connection.createSession(false, javax.jms.Session.AUTO_ACKNOWLEDGE);
          try {
            javax.jms.Queue queue = session.createQueue("jerry.fixture.instrumentation");
            javax.jms.MessageProducer producer = session.createProducer(queue);
            javax.jms.MessageConsumer consumer = session.createConsumer(queue);
            try {
              producer.send(session.createTextMessage("fixture-private-message"));
              if (consumer.receive(2000) == null)
                throw new IllegalStateException("JMS message not received");
              producer.close();
              try {
                producer.send(session.createTextMessage("fixture-private-message"));
                throw new IllegalStateException("Expected JMS failure");
              } catch (javax.jms.JMSException expected) {
              }
            } finally {
              producer.close();
              consumer.close();
            }
          } finally {
            session.close();
          }
        } finally {
          connection.close();
        }
        RestTemplate http = new RestTemplate();
        http.getInterceptors().add(new JerryHttpInterceptor(getServletContext()));
        http.getForObject(
            "http://127.0.0.1:" + request.getServerPort() + "/jerry-demo/api", String.class);
        try {
          http.getForObject(
              "http://127.0.0.1:" + request.getServerPort() + "/jerry-framework/api?action=error",
              String.class);
        } catch (org.springframework.web.client.HttpServerErrorException expected) {
        }
      } catch (Exception exception) {
        throw new IOException("Instrumented fixture failed", exception);
      }
    int download = 0;
    try {
      download = Math.min(262144, Math.max(0, Integer.parseInt(request.getParameter("download"))));
    } catch (Exception ignored) {
    }
    StringBuilder payload = new StringBuilder();
    for (int i = 0; i < download; i++) payload.append('x');
    response
        .getWriter()
        .write(
            "{\"lazyConstructed\":"
                + lazy.get()
                + ",\"secretReads\":"
                + secretReads.get()
                + ",\"jobs\":"
                + jobs.get()
                + ",\"payload\":\""
                + payload
                + "\"}");
  }

  @Override
  protected void doPost(HttpServletRequest request, HttpServletResponse response)
      throws IOException {
    byte[] buffer = new byte[8192];
    int total = 0, count;
    while ((count = request.getInputStream().read(buffer)) != -1) {
      total += count;
      if (total > 1048576) {
        response.sendError(413);
        return;
      }
    }
    doGet(request, response);
  }
}
